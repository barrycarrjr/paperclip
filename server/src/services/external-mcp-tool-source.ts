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
 */

import type { Db } from "@paperclipai/db";
import { externalMcpServers } from "@paperclipai/db";
import { EXTERNAL_MCP_TOOL_NAMESPACE, isCompanyAllowed } from "@paperclipai/shared";
import type { ExternalMcpServerRecord } from "@paperclipai/shared";
import {
  ExternalMcpWarmingError,
  type ExternalMcpServerManager,
  type ExternalMcpToolDescriptor,
} from "./external-mcp-server-manager.js";
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

interface CachedTools {
  tools: ExternalMcpAggregatedTool[];
  expiresAt: number;
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

  async function discoverServer(
    server: ExternalMcpServerRecord,
    companyId: string,
  ): Promise<ExternalMcpAggregatedTool[]> {
    const key = `${server.id}::${companyId}`;
    const now = Date.now();
    const generation = manager.configGeneration();

    const cached = toolCache.get(key);
    if (cached && cached.expiresAt > now && cached.generation === generation) {
      return cached.tools;
    }
    if (cached) toolCache.delete(key);

    // A pooled client answers immediately, so a server that finished warming
    // rejoins on the very next turn rather than serving out its cool-off.
    const ready = manager.isReady(server.id, companyId);
    if (!ready) {
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
      const aggregated = tools.map((tool) => ({
        ...tool,
        serverId: server.id,
        serverKey: server.key,
        namespacedName: buildNamespacedName(server.key, tool.name),
      }));
      toolCache.set(key, {
        tools: aggregated,
        expiresAt: Date.now() + TOOL_CACHE_TTL_MS,
        generation,
      });
      coolOff.delete(key);
      return aggregated;
    } catch (err) {
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
      } else {
        log.warn(detail, "failed to list tools for external mcp server (skipping)");
      }
      return [];
    }
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
  };
}

export type CreateExternalMcpToolSource = ReturnType<typeof createExternalMcpToolSource>;
