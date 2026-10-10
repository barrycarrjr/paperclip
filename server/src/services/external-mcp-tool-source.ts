/**
 * External MCP tool source — discovery loop that asks each registered MCP
 * server for its tool list (via the manager) and returns descriptors that
 * the dispatcher merges with the plugin tool registry.
 *
 * The dispatcher namespaces external MCP tools as `mcp:<server.key>:<tool>`.
 * Tool name parsing happens in the dispatcher; this module only concerns
 * itself with the discovery side.
 *
 * Discovery is done per (server, callerCompanyId) so allow-lists and
 * mutation gates can be enforced at the right granularity. Cache lifetime
 * is short — we want config edits to take effect immediately.
 *
 * This runs on the critical path of every agent turn: the model cannot be
 * called until it knows what tools it has. So the rules here are (a) never
 * wait on a cold server longer than `DISCOVERY_DEADLINE_MS`, (b) query
 * servers concurrently rather than one after another, and (c) after a server
 * misses its deadline, stop asking for a cool-off period instead of paying
 * the same wait on every single turn. A server that is merely slow to start
 * keeps warming in the background and joins in as soon as it is ready.
 *
 * Once a server has listed its tools it keeps them while it reconnects. The
 * manager closes a client after five idle minutes and Docker's MCP gateway
 * takes 20 to 70 seconds to come back, so dropping the tools for that window
 * hit nearly every turn after a pause. In a resumed Claude Code session the
 * missing tools were then announced as "no longer available (their MCP
 * server disconnected)", and Clippy told people its tools were disconnected
 * when they worked. A call to a tool kept this way waits for the reconnect,
 * as any call to a cold server does. `warmUp()` connects the servers when
 * Paperclip starts, so there is a list to keep from the first turn after a
 * restart.
 */

import type { Db } from "@paperclipai/db";
import { companies, externalMcpServers } from "@paperclipai/db";
import {
  EXTERNAL_MCP_TOOL_NAMESPACE,
  PORTFOLIO_WIDE_COMPANY_TOKEN,
  isCompanyAllowed,
  isPortfolioWide,
} from "@paperclipai/shared";
import type { ExternalMcpServerRecord } from "@paperclipai/shared";
import {
  ExternalMcpWarmingError,
  type ExternalMcpServerManager,
  type ExternalMcpToolDescriptor,
} from "./external-mcp-server-manager.js";
import { hasCompanyScopedBindings } from "./external-mcp-secrets.js";
import { logger } from "../middleware/logger.js";

/**
 * How long a single server gets to answer before we leave it out of this
 * turn's tool list. Comfortably above a healthy stdio server (<2s) and far
 * below anything a person would sit through.
 */
const DISCOVERY_DEADLINE_MS = 5_000;
/**
 * How long a successful tool list stays fresh. Short, so operator config
 * edits show up quickly; eviction bumps the manager's config generation and
 * drops these entries immediately anyway.
 */
const TOOL_CACHE_TTL_MS = 30_000;
/**
 * How long to leave a server alone after it misses its deadline or errors.
 * Bypassed the moment the manager reports the client as connected, so a slow
 * starter is picked up on the next turn rather than sitting out the cool-off.
 */
const FAILURE_COOLOFF_MS = 60_000;
/**
 * How many servers the start-up warm-up connects at once. Each is a child
 * process, and for Docker's MCP gateway a container per enabled server, so a
 * long registry should not all start in the same second as everything else.
 */
const WARM_UP_CONCURRENCY = 2;

interface CachedTools {
  tools: ExternalMcpAggregatedTool[];
  expiresAt: number;
  generation: number;
}

interface KnownTools {
  tools: ExternalMcpAggregatedTool[];
  generation: number;
}

interface Recording {
  promise: Promise<boolean>;
  /** The server's config generation when its record was read. */
  generation: number;
}

interface WarmUpTarget {
  server: ExternalMcpServerRecord;
  companyId: string;
  generation: number;
}

export interface ExternalMcpAggregatedTool extends ExternalMcpToolDescriptor {
  serverId: string;
  serverKey: string;
  /** Fully namespaced name: `mcp:<serverKey>:<toolName>`. */
  namespacedName: string;
}

export interface ExternalMcpToolSource {
  /**
   * List all tools visible to the calling company across every registered
   * MCP server the company is allowed to use.
   */
  listToolsForCompany(companyId: string): Promise<ExternalMcpAggregatedTool[]>;

  /**
   * List servers the operator has registered. Board-only callers can pass
   * `companyId === null` to bypass the allowedCompanies filter.
   */
  listServers(companyId: string | null): Promise<ExternalMcpServerRecord[]>;

  /** Build the namespaced tool ID for a (server, tool) pair. */
  buildNamespacedName(serverKey: string, toolName: string): string;

  /** Parse `mcp:<server>:<tool>` into its parts; returns null on miss. */
  parseNamespacedName(namespaced: string): { serverKey: string; toolName: string } | null;

  /**
   * Connect the registered servers in the background and record their tool
   * lists, so the turns after a restart have them. Resolves once every
   * connect has settled and never rejects: start-up does not wait for it,
   * and a server that cannot start is logged and left to the next turn.
   */
  warmUp(): Promise<void>;
}

function dbRowToRecord(
  row: typeof externalMcpServers.$inferSelect,
): ExternalMcpServerRecord {
  return {
    id: row.id,
    key: row.key,
    displayName: row.displayName,
    description: row.description,
    transport: row.transport,
    command: row.command,
    args: row.args,
    url: row.url,
    envBindings: row.envBindings ?? {},
    headerBindings: row.headerBindings ?? {},
    allowedCompanies: row.allowedCompanies ?? [],
    allowMutations: row.allowMutations,
    writeAllowList: row.writeAllowList ?? [],
    toolAllowList: row.toolAllowList ?? [],
    toolDenyList: row.toolDenyList ?? [],
    lastError: row.lastError,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createExternalMcpToolSource(
  db: Db,
  manager: ExternalMcpServerManager,
): ExternalMcpToolSource {
  const log = logger.child({ service: "external-mcp-tool-source" });
  // Both keyed by `${serverId}::${companyId}`.
  const toolCache = new Map<string, CachedTools>();
  const coolOff = new Map<string, number>();
  // The latest successful listing, kept past the cache TTL so a server that
  // is reconnecting keeps its tools. Keyed by `lastKnownKey()`.
  const lastKnown = new Map<string, KnownTools>();
  // Background connects that record a tool list when they land, keyed by
  // `${serverId}::${companyId}` so a burst of turns starts only one.
  const recording = new Map<string, Recording>();

  function buildNamespacedName(serverKey: string, toolName: string): string {
    return `${EXTERNAL_MCP_TOOL_NAMESPACE}:${serverKey}:${toolName}`;
  }

  function parseNamespacedName(name: string): { serverKey: string; toolName: string } | null {
    const prefix = `${EXTERNAL_MCP_TOOL_NAMESPACE}:`;
    if (!name.startsWith(prefix)) return null;
    const rest = name.slice(prefix.length);
    const sep = rest.indexOf(":");
    if (sep <= 0 || sep >= rest.length - 1) return null;
    return {
      serverKey: rest.slice(0, sep),
      toolName: rest.slice(sep + 1),
    };
  }

  async function listServers(companyId: string | null): Promise<ExternalMcpServerRecord[]> {
    const rows = await db.select().from(externalMcpServers);
    const records = rows.map(dbRowToRecord);
    if (companyId === null) return records;
    return records.filter((r) => isCompanyAllowed(r.allowedCompanies, companyId));
  }

  /**
   * Where a server's last known tools are kept. When nothing in its config
   * depends on the company, every company runs the same process and sees the
   * same tools, so one company's listing (or one warm-up) stands for all.
   */
  function lastKnownKey(server: ExternalMcpServerRecord, companyId: string): string {
    return hasCompanyScopedBindings(server) ? `${server.id}::${companyId}` : server.id;
  }

  function readLastKnown(
    server: ExternalMcpServerRecord,
    companyId: string,
    generation: number,
  ): ExternalMcpAggregatedTool[] | null {
    const key = lastKnownKey(server, companyId);
    const known = lastKnown.get(key);
    if (!known) return null;
    // An operator edit can change the command or the allow and deny lists,
    // so a list from before one is not safe to show.
    if (known.generation !== generation) {
      lastKnown.delete(key);
      return null;
    }
    return known.tools;
  }

  function aggregate(
    server: ExternalMcpServerRecord,
    tools: ExternalMcpToolDescriptor[],
  ): ExternalMcpAggregatedTool[] {
    return tools.map((tool) => ({
      ...tool,
      serverId: server.id,
      serverKey: server.key,
      namespacedName: buildNamespacedName(server.key, tool.name),
    }));
  }

  function record(
    server: ExternalMcpServerRecord,
    companyId: string,
    tools: ExternalMcpToolDescriptor[],
    generation: number,
  ): ExternalMcpAggregatedTool[] {
    const key = `${server.id}::${companyId}`;
    const aggregated = aggregate(server, tools);
    toolCache.set(key, {
      tools: aggregated,
      expiresAt: Date.now() + TOOL_CACHE_TTL_MS,
      generation,
    });
    lastKnown.set(lastKnownKey(server, companyId), { tools: aggregated, generation });
    coolOff.delete(key);
    return aggregated;
  }

  /**
   * Connect with the full budget and record the tool list when it lands.
   * Used by the start-up warm-up, after a turn gives up waiting on a cold
   * server, and while a turn is served a server's last known tools. Joins a
   * connect already under way rather than starting another.
   *
   * `generation` is the server's config generation when its record was
   * read. An outcome that arrives after an edit says nothing about the new
   * settings, so it is ignored, tools and failures alike. Never rejects: a
   * server that fails to connect under its current settings loses its kept
   * tools, since none of them can run, and sits out the cool-off.
   */
  function connectAndRecord(
    server: ExternalMcpServerRecord,
    companyId: string,
    generation: number,
  ): Promise<boolean> {
    const key = `${server.id}::${companyId}`;
    if (manager.configGeneration(server.id) !== generation) return Promise.resolve(false);
    const inFlight = recording.get(key);
    if (inFlight && inFlight.generation === generation) return inFlight.promise;

    const promise: Promise<boolean> = manager
      .listTools(server.id, companyId)
      .then((tools) => {
        // Edited while it connected: these may be the old settings' tools,
        // and must not replace a list recorded under the new ones.
        if (manager.configGeneration(server.id) !== generation) return false;
        record(server, companyId, tools, generation);
        return true;
      })
      .catch((err: unknown) => {
        // Likewise a failure after an edit, such as the manager closing a
        // connect that started with the old settings: no cool-off, and the
        // tools recorded under the new settings stay.
        if (manager.configGeneration(server.id) !== generation) return false;
        coolOff.set(key, Date.now() + FAILURE_COOLOFF_MS);
        lastKnown.delete(lastKnownKey(server, companyId));
        log.warn(
          {
            serverKey: server.key,
            companyId,
            coolOffMs: FAILURE_COOLOFF_MS,
            err: err instanceof Error ? err.message : String(err),
          },
          "external mcp server failed to connect (its tools are left out until it does)",
        );
        return false;
      })
      .finally(() => {
        if (recording.get(key)?.promise === promise) recording.delete(key);
      });
    recording.set(key, { promise, generation });
    return promise;
  }

  async function discoverServer(
    server: ExternalMcpServerRecord,
    companyId: string,
  ): Promise<ExternalMcpAggregatedTool[]> {
    const key = `${server.id}::${companyId}`;
    const now = Date.now();
    const generation = manager.configGeneration(server.id);

    const cached = toolCache.get(key);
    if (cached && cached.expiresAt > now && cached.generation === generation) {
      return cached.tools;
    }
    if (cached) toolCache.delete(key);

    // A pooled client answers immediately, so a server that finished warming
    // rejoins on the very next turn rather than serving out its cool-off.
    const ready = manager.isReady(server.id, companyId);
    if (!ready) {
      // Listed before and reconnecting now (closed while idle, or this
      // company has not connected yet): keep its tools rather than make the
      // turn wait or drop them. Shrinking the list is what a resumed session
      // reported as a disconnected server.
      const known = readLastKnown(server, companyId, generation);
      if (known) {
        if (recording.get(key)?.generation !== generation) {
          log.info(
            { serverKey: server.key, companyId, toolCount: known.length },
            "external mcp server reconnecting (keeping its last known tools this turn)",
          );
        }
        void connectAndRecord(server, companyId, generation);
        return known;
      }
      const coolingUntil = coolOff.get(key);
      if (coolingUntil !== undefined && coolingUntil > now) return [];
      if (coolingUntil !== undefined) coolOff.delete(key);
    }

    try {
      const tools = await manager.listTools(server.id, companyId, {
        // Already connected: no cold start to guard against, and a pooled
        // `tools/list` is a cheap round-trip.
        deadlineMs: ready ? undefined : DISCOVERY_DEADLINE_MS,
      });
      // Edited during the call: show what was listed this once, but do not
      // keep it as the server's tools under the new settings.
      if (manager.configGeneration(server.id) !== generation) return aggregate(server, tools);
      return record(server, companyId, tools, generation);
    } catch (err) {
      // Edited during the call, for instance the manager closing a connect
      // that started with the old settings. Nothing says the server itself
      // is broken, so no cool-off: the next turn connects with the new ones.
      if (manager.configGeneration(server.id) !== generation) return [];
      coolOff.set(key, Date.now() + FAILURE_COOLOFF_MS);
      const warming = err instanceof ExternalMcpWarmingError;
      const detail = {
        serverKey: server.key,
        companyId,
        coolOffMs: FAILURE_COOLOFF_MS,
        err: err instanceof Error ? err.message : String(err),
      };
      if (warming) {
        // Not an error: the server is just slow to start. It keeps
        // connecting in the background and will be picked up once ready.
        log.info(detail, "external mcp server still warming up (skipping this turn)");
        // Record its tools the moment that connect lands, so it keeps them
        // through its next reconnect even if no turn comes before then.
        void connectAndRecord(server, companyId, generation);
      } else {
        log.warn(detail, "failed to list tools for external mcp server (skipping)");
      }
      return [];
    }
  }

  /**
   * The companies warm-up may connect as: active ones only. An archived or
   * paused company gets no process started with its secrets on every boot,
   * and a company that no longer exists is not in the list at all. Sorted
   * HQ first, then oldest first, which is the order a portfolio-wide server
   * picks from.
   */
  async function activeCompaniesForWarmUp(): Promise<string[]> {
    const rows = await db
      .select({
        id: companies.id,
        status: companies.status,
        isPortfolioRoot: companies.isPortfolioRoot,
        createdAt: companies.createdAt,
      })
      .from(companies);
    return rows
      .filter((row) => row.status === "active")
      .sort(
        (a, b) =>
          Number(b.isPortfolioRoot) - Number(a.isPortfolioRoot) ||
          a.createdAt.getTime() - b.createdAt.getTime(),
      )
      .map((row) => row.id);
  }

  /**
   * What to connect at start-up, and as which company. Warming every company
   * of a portfolio-wide server would start a process per company (with twelve
   * companies, twelve Docker gateways and twelve sets of containers), so this
   * warms what is cheap: one connect per server whose config is the same for
   * everyone, which records the tool list for all of its companies, and one
   * per named company for a server whose secrets differ by company. A
   * portfolio-wide server with company secrets is left to connect on first
   * use; its tools are kept from then on. A portfolio-wide server is warmed
   * as HQ, or the oldest active company when HQ is not active; any company
   * gets the same tools from it, so this only decides whose client is
   * already connected for the first few minutes.
   */
  async function chooseWarmUpTargets(): Promise<WarmUpTarget[]> {
    const servers = await listServers(null);
    if (servers.length === 0) return [];
    const active = await activeCompaniesForWarmUp();
    const activeIds = new Set(active);
    const targets: WarmUpTarget[] = [];
    for (const server of servers) {
      // Read alongside the record, so an edit made while this connects
      // keeps its result from being recorded.
      const generation = manager.configGeneration(server.id);
      const named = server.allowedCompanies.filter(
        (companyId) => companyId !== PORTFOLIO_WIDE_COMPANY_TOKEN && activeIds.has(companyId),
      );
      if (hasCompanyScopedBindings(server)) {
        for (const companyId of named) targets.push({ server, companyId, generation });
        continue;
      }
      const companyId =
        named[0] ?? (isPortfolioWide(server.allowedCompanies) ? active[0] : undefined);
      if (companyId) targets.push({ server, companyId, generation });
    }
    return targets;
  }

  async function warmUp(): Promise<void> {
    let targets: WarmUpTarget[];
    try {
      targets = await chooseWarmUpTargets();
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "could not read external mcp servers to warm up (they connect on first use instead)",
      );
      return;
    }
    if (targets.length === 0) return;

    log.info(
      { servers: targets.map((t) => ({ serverKey: t.server.key, companyId: t.companyId })) },
      "warming up external mcp servers in the background",
    );
    let next = 0;
    let warmed = 0;
    const worker = async (): Promise<void> => {
      while (next < targets.length) {
        const target = targets[next++]!;
        if (await connectAndRecord(target.server, target.companyId, target.generation)) warmed += 1;
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(WARM_UP_CONCURRENCY, targets.length) }, () => worker()),
    );
    log.info({ warmed, total: targets.length }, "external mcp warm-up finished");
  }

  async function listToolsForCompany(companyId: string): Promise<ExternalMcpAggregatedTool[]> {
    const servers = await listServers(companyId);
    // Concurrently. One slow server used to delay every server behind it.
    const settled = await Promise.allSettled(
      servers.map((server) => discoverServer(server, companyId)),
    );

    const out: ExternalMcpAggregatedTool[] = [];
    for (const [index, result] of settled.entries()) {
      if (result.status === "fulfilled") {
        out.push(...result.value);
        continue;
      }
      // discoverServer handles its own failures; this is a last-resort guard
      // so one unexpected throw cannot empty the whole tool list.
      log.warn(
        {
          serverKey: servers[index]?.key,
          companyId,
          err:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        },
        "external mcp discovery threw unexpectedly (skipping)",
      );
    }
    return out;
  }

  return {
    listToolsForCompany,
    listServers,
    buildNamespacedName,
    parseNamespacedName,
    warmUp,
  };
}

export type CreateExternalMcpToolSource = ReturnType<typeof createExternalMcpToolSource>;
