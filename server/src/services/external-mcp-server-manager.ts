/**
 * External MCP server manager — lifecycle for outbound MCP client sessions.
 *
 * For each (serverId, companyId) tuple we lazily create one MCP `Client`
 * connection: stdio (spawn child process with resolved env) or
 * Streamable HTTP / SSE (with resolved auth headers). Connections idle out
 * after `IDLE_TIMEOUT_MS`, are torn down on server config update, and are
 * restarted on next call after a crash.
 *
 * Why per-(serverId, companyId)? Because env / header bindings can carry
 * company-scoped secrets — different callers may resolve different values
 * for the same MCP server config. Sharing one client across companies
 * would mix credentials.
 */

import type { Db } from "@paperclipai/db";
import { externalMcpServers } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import type { ExternalMcpServerRecord } from "@paperclipai/shared";
import { isLikelyMutationToolName } from "@paperclipai/shared";
import { isCompanyAllowed } from "@paperclipai/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  externalMcpSecretsService,
  type ExternalMcpSecretsService,
} from "./external-mcp-secrets.js";
import { logger } from "../middleware/logger.js";

const IDLE_TIMEOUT_MS = 5 * 60_000;
// 2 min — most stdio servers connect in <2s, but multi-server gateways like
// Docker MCP Gateway do a full container cold-start per enabled server during
// tools/list enumeration and routinely take 30-90s.
const CONNECT_TIMEOUT_MS = 120_000;
const CALL_TIMEOUT_MS = 120_000;

/**
 * Host env vars to pass into spawned stdio MCP servers beyond what the SDK
 * inherits by default (see `DEFAULT_INHERITED_ENV_VARS` in
 * @modelcontextprotocol/sdk/client/stdio.js).
 *
 * The SDK's Windows allowlist covers APPDATA, LOCALAPPDATA, PATH, PROGRAMFILES,
 * SYSTEMROOT, USERPROFILE, etc. — but not ProgramData, which Docker Desktop's
 * MCP Gateway panics on if missing (`unable to get 'ProgramData'` → child exits
 * → SDK reports `MCP error -32000: Connection closed`). PATHEXT is added so
 * cross-spawn can resolve bare command names like `docker` to `docker.exe`
 * without relying on shell expansion.
 */
const EXTRA_HOST_ENV_KEYS_WIN32 = ["ProgramData", "ProgramFiles(x86)", "PATHEXT"];

function getExtraHostEnv(): Record<string, string> {
  if (process.platform !== "win32") return {};
  const env: Record<string, string> = {};
  for (const key of EXTRA_HOST_ENV_KEYS_WIN32) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Thrown when a discovery call gives up waiting for a cold server to finish
 * its handshake. The connect itself is *not* cancelled: it keeps warming in
 * the background so a later call can use the pooled client. Callers should
 * treat this as "not ready yet" rather than as a failure.
 */
export class ExternalMcpWarmingError extends Error {
  readonly code = "EWARMING" as const;
  readonly serverKey: string;

  constructor(serverKey: string, waitedMs: number) {
    super(
      `MCP server "${serverKey}" is still starting up (waited ${waitedMs}ms); ` +
        `it continues connecting in the background`,
    );
    this.name = "ExternalMcpWarmingError";
    this.serverKey = serverKey;
  }
}

/**
 * Thrown to callers of a connect that finished after an operator edited or
 * deleted the server. That process was started with the old command, URL,
 * env or credentials, so it is closed instead of being kept. Calling again
 * connects with the current settings.
 */
export class ExternalMcpConfigChangedError extends Error {
  readonly code = "ECONFIG_CHANGED" as const;
  readonly serverKey: string;

  constructor(serverKey: string) {
    super(
      `MCP server "${serverKey}" was edited while it was connecting; that connection ` +
        `used the old settings and was closed, so call it again`,
    );
    this.name = "ExternalMcpConfigChangedError";
    this.serverKey = serverKey;
  }
}

/**
 * True when a failed call means the connection itself is gone or stuck, so
 * the client should be rebuilt. A server that answered with an error (an
 * unknown tool, bad arguments, its own failure) is still connected: closing
 * it would throw away a process that can take most of a minute to start.
 */
function isConnectionError(err: unknown): boolean {
  if (!(err instanceof McpError)) return true;
  return err.code === ErrorCode.ConnectionClosed || err.code === ErrorCode.RequestTimeout;
}

interface PooledClient {
  client: Client;
  /** Set of redacted env keys / header names — for log scrubbing. */
  secretEnvKeys: Set<string>;
  secretHeaderKeys: Set<string>;
  serverVersion: string;
  lastUsedAt: number;
  idleTimer: NodeJS.Timeout | null;
  closing: boolean;
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

export interface ExternalMcpToolDescriptor {
  name: string;
  description: string;
  parametersSchema: Record<string, unknown>;
}

export interface ExternalMcpCallResult {
  content: unknown;
  isError: boolean;
}

export interface ExternalMcpServerManager {
  /** Look up a server record by id. */
  getServer(serverId: string): Promise<ExternalMcpServerRecord | null>;
  /** Look up a server record by key. */
  getServerByKey(key: string): Promise<ExternalMcpServerRecord | null>;
  /**
   * Connect (or reuse) and list the server's tools for the calling company.
   *
   * Pass `deadlineMs` from latency-sensitive callers (agent tool discovery):
   * if the server has not finished connecting by then the call rejects with
   * `ExternalMcpWarmingError` while the connect continues in the background.
   * Omit it to wait out the full connect budget.
   */
  listTools(
    serverId: string,
    companyId: string,
    options?: { deadlineMs?: number },
  ): Promise<ExternalMcpToolDescriptor[]>;
  /**
   * True when a client for this (server, company) is already connected and
   * pooled, i.e. `listTools` will answer without paying a cold start.
   */
  isReady(serverId: string, companyId: string): boolean;
  /**
   * Incremented for a server whenever an operator edit or delete evicts its
   * clients. Callers that cache discovery results key off this so an edit
   * takes effect at once instead of waiting for a cache TTL, without
   * discarding what they know about every other server.
   */
  configGeneration(serverId: string): number;
  /** Call a tool by its bare name (not namespaced). Mutation gating happens here. */
  callTool(
    serverId: string,
    companyId: string,
    toolName: string,
    args: unknown,
  ): Promise<ExternalMcpCallResult>;
  /**
   * Without a company: the server's settings changed (edit or delete). Its
   * clients are closed, its config generation moves on, and a connect still
   * starting with the old settings is closed when it lands. With a company:
   * just that one client is closed (the test-connect probe), which changes
   * no settings.
   */
  evict(serverId: string, companyId?: string): Promise<void>;
  /**
   * Tear down everything, including clients still starting. Called during
   * graceful shutdown.
   */
  shutdown(): Promise<void>;
}

export interface ExternalMcpServerManagerOptions {
  idleTimeoutMs?: number;
  /** Overrides `CONNECT_TIMEOUT_MS`. Exposed for tests. */
  connectTimeoutMs?: number;
}

export function createExternalMcpServerManager(
  db: Db,
  options: ExternalMcpServerManagerOptions = {},
): ExternalMcpServerManager {
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const log = logger.child({ service: "external-mcp-server-manager" });
  const secrets: ExternalMcpSecretsService = externalMcpSecretsService(db);

  // Pool keyed by `${serverId}::${companyId}`.
  const pool = new Map<string, PooledClient>();
  // In-flight connects, keyed the same way. Without this every caller that
  // arrives during a cold start spawns its own child process. With a gateway
  // that takes 60-90s to come up that means several redundant containers, and
  // each one competing for the same Docker daemon makes the start-up slower
  // still.
  const connecting = new Map<string, Promise<PooledClient>>();
  // Per server, bumped when an operator edit or delete evicts it, so
  // downstream discovery caches drop that server's entries at once. Per
  // server so that editing one does not wipe what is known about the rest.
  const generations = new Map<string, number>();
  // Clients whose connect has not finished yet, so shutdown can stop them too.
  const starting = new Set<Client>();
  let shuttingDown = false;

  function poolKey(serverId: string, companyId: string): string {
    return `${serverId}::${companyId}`;
  }

  function generationOf(serverId: string): number {
    return generations.get(serverId) ?? 0;
  }

  async function closeClient(client: Client, key: string, reason: string): Promise<void> {
    try {
      await client.close();
    } catch (err) {
      log.warn({ key, reason, err: err instanceof Error ? err.message : String(err) }, "client close failed");
    }
  }

  function scheduleIdleEviction(key: string, pooled: PooledClient): void {
    if (pooled.idleTimer) clearTimeout(pooled.idleTimer);
    pooled.idleTimer = setTimeout(() => {
      void evictByKey(key, "idle-timeout");
    }, idleTimeoutMs);
    // Keep the timer un-ref'd so it doesn't hold the process open.
    pooled.idleTimer.unref?.();
  }

  async function evictByKey(key: string, reason: string): Promise<void> {
    const pooled = pool.get(key);
    if (!pooled) return;
    if (pooled.closing) return;
    pooled.closing = true;
    if (pooled.idleTimer) {
      clearTimeout(pooled.idleTimer);
      pooled.idleTimer = null;
    }
    pool.delete(key);
    await closeClient(pooled.client, key, reason);
    log.debug({ key, reason }, "external mcp client evicted");
  }

  async function buildTransport(
    server: ExternalMcpServerRecord,
    resolved: Awaited<ReturnType<ExternalMcpSecretsService["resolveBindings"]>>,
  ): Promise<{
    transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
    getStderrTail?: () => string;
    cleanup?: () => Promise<void>;
  }> {
    if (server.transport === "stdio") {
      if (!server.command) {
        throw new Error(`MCP server "${server.key}" is stdio transport but has no command`);
      }
      // Layer extra host env (e.g. Windows ProgramData) under the operator's
      // resolved bindings — the SDK then merges its own default allowlist
      // under all of this when it spawns.
      const transport = new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env: { ...getExtraHostEnv(), ...resolved.env },
        stderr: "pipe",
      });
      // Accumulate stderr so the connect() catch-block can surface the child's
      // actual exit reason (panic, missing binary, auth error) instead of the
      // SDK's opaque "MCP error -32000: Connection closed".
      const stderrChunks: string[] = [];
      const STDERR_TAIL_MAX = 4096;
      transport.stderr?.on("data", (chunk) => {
        const text = String(chunk);
        stderrChunks.push(text);
        // Keep memory bounded — drop oldest chunks if we exceed the cap.
        let total = stderrChunks.reduce((n, s) => n + s.length, 0);
        while (total > STDERR_TAIL_MAX && stderrChunks.length > 1) {
          total -= stderrChunks.shift()!.length;
        }
        log.debug(
          { serverKey: server.key, stderr: text.slice(0, 1024) },
          "stdio mcp stderr",
        );
      });
      return {
        transport,
        getStderrTail: () => stderrChunks.join("").slice(-STDERR_TAIL_MAX),
      };
    }

    if (server.transport === "http") {
      if (!server.url) {
        throw new Error(`MCP server "${server.key}" is http transport but has no url`);
      }
      const transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: resolved.headers },
      });
      return { transport };
    }

    if (!server.url) {
      throw new Error(`MCP server "${server.key}" is sse transport but has no url`);
    }
    const transport = new SSEClientTransport(new URL(server.url), {
      requestInit: { headers: resolved.headers },
    });
    return { transport };
  }

  async function connect(
    server: ExternalMcpServerRecord,
    companyId: string,
  ): Promise<PooledClient> {
    const resolved = await secrets.resolveBindings(server, { callerCompanyId: companyId });

    const client = new Client({
      name: "paperclip-external-mcp-host",
      version: "0.1.0",
    });

    const { transport, getStderrTail } = await buildTransport(server, resolved);

    // Pass the timeout explicitly. The SDK's `initialize` request otherwise
    // uses its own `DEFAULT_REQUEST_TIMEOUT_MSEC` (60s), which fires long
    // before CONNECT_TIMEOUT_MS and makes the race below unreachable. The
    // handshake was being abandoned at exactly 60s with
    // "MCP error -32001: Request timed out" no matter how generous our budget
    // was. That is what stopped Docker MCP Gateway ever finishing a cold
    // start, since it enumerates every enabled server before answering.
    starting.add(client);
    const connectPromise = client.connect(transport, { timeout: connectTimeoutMs });
    // Belt-and-braces for transports that hang before `initialize` is even
    // sent (a stdio child that never execs never gets an SDK-side timeout).
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`MCP connect timed out after ${connectTimeoutMs}ms`)),
        connectTimeoutMs,
      ).unref?.();
    });
    try {
      await Promise.race([connectPromise, timeoutPromise]);
    } catch (err) {
      // Give the child a beat to finish flushing stderr after stdin closes.
      await new Promise((resolve) => setTimeout(resolve, 250).unref?.());
      const stderrTail = getStderrTail?.().trim() ?? "";
      const baseMessage = err instanceof Error ? err.message : String(err);
      const passedEnvKeys =
        server.transport === "stdio"
          ? Object.keys({ ...getExtraHostEnv(), ...resolved.env }).sort().join(", ")
          : "";
      const diag =
        server.transport === "stdio"
          ? `Spawn: ${server.command} ${(server.args ?? []).join(" ")}\n` +
            `Extra env passed: ${passedEnvKeys || "(none)"}\n`
          : "";
      const stderrBlock = stderrTail
        ? `\nChild stderr:\n${stderrTail}`
        : `\n(child wrote nothing to stderr)`;
      const enriched = new Error(`${baseMessage}\n\n[diag-v2]\n${diag}${stderrBlock}`);
      enriched.stack = err instanceof Error ? err.stack : undefined;
      throw enriched;
    } finally {
      starting.delete(client);
    }

    const serverInfo = client.getServerVersion();

    const pooled: PooledClient = {
      client,
      secretEnvKeys: resolved.secretEnvKeys,
      secretHeaderKeys: resolved.secretHeaderKeys,
      serverVersion: serverInfo?.version ?? "unknown",
      lastUsedAt: Date.now(),
      idleTimer: null,
      closing: false,
    };

    return pooled;
  }

  /**
   * Start a connect, or join the one already running for this key. The
   * returned promise is shared, so a slow cold start is paid once no matter
   * how many callers arrive during it.
   */
  function beginConnect(
    server: ExternalMcpServerRecord,
    companyId: string,
    key: string,
  ): Promise<PooledClient> {
    const inFlight = connecting.get(key);
    if (inFlight) return inFlight;

    const startedAt = Date.now();
    // The settings this connect starts with are current as of this count.
    const startedGeneration = generationOf(server.id);
    const promise: Promise<PooledClient> = connect(server, companyId)
      .then((pooled) => {
        if (shuttingDown || generationOf(server.id) !== startedGeneration) {
          // Edited or deleted while it connected, or Paperclip is stopping.
          // This process runs the old command, URL, env or credentials, so it
          // must not become the live client. Closed in the background so the
          // callers hear about it at once.
          const reason = shuttingDown ? "shutdown" : "edited-while-connecting";
          void closeClient(pooled.client, key, reason);
          log.info(
            { serverKey: server.key, companyId, reason },
            "external mcp client closed as soon as it connected",
          );
          if (shuttingDown) throw new Error("External MCP connections are shutting down");
          throw new ExternalMcpConfigChangedError(server.key);
        }
        pool.set(key, pooled);
        scheduleIdleEviction(key, pooled);
        log.info(
          { serverKey: server.key, companyId, connectMs: Date.now() - startedAt },
          "external mcp client connected",
        );
        return pooled;
      })
      .finally(() => {
        // An edit takes a connect still starting out of this map so later
        // callers start afresh, so only remove the entry if it is this one.
        if (connecting.get(key) === promise) connecting.delete(key);
      });

    connecting.set(key, promise);
    // A caller that walked away at its deadline leaves nobody awaiting this
    // promise; mark it handled so a later failure can't surface as an
    // unhandled rejection. Callers still see rejections from their own await.
    promise.catch(() => {});
    return promise;
  }

  async function getOrCreate(
    server: ExternalMcpServerRecord,
    companyId: string,
    deadlineMs?: number,
  ): Promise<PooledClient> {
    const key = poolKey(server.id, companyId);
    const pooled = pool.get(key);
    if (pooled && !pooled.closing) {
      pooled.lastUsedAt = Date.now();
      scheduleIdleEviction(key, pooled);
      return pooled;
    }

    const connectPromise = beginConnect(server, companyId, key);
    if (deadlineMs === undefined) return connectPromise;

    // Wait only as long as the caller can afford. The connect is deliberately
    // left running: it will populate the pool for the next call.
    let deadlineTimer: NodeJS.Timeout | undefined;
    const deadlinePromise = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(
        () => reject(new ExternalMcpWarmingError(server.key, deadlineMs)),
        deadlineMs,
      );
      deadlineTimer.unref?.();
    });
    try {
      return await Promise.race([connectPromise, deadlinePromise]);
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }
  }

  function isToolBlocked(server: ExternalMcpServerRecord, toolName: string): { blocked: boolean; reason?: string } {
    if (server.toolDenyList.includes(toolName)) {
      return { blocked: true, reason: "tool is in deny list" };
    }
    if (server.toolAllowList.length > 0 && !server.toolAllowList.includes(toolName)) {
      return { blocked: true, reason: "tool is not in allow list" };
    }
    return { blocked: false };
  }

  function isMutationGated(server: ExternalMcpServerRecord, toolName: string, isLikelyMutation: boolean): boolean {
    if (server.allowMutations) return false;
    if (!isLikelyMutation) return false;
    return !server.writeAllowList.includes(toolName);
  }

  async function getServerById(serverId: string): Promise<ExternalMcpServerRecord | null> {
    const rows = await db
      .select()
      .from(externalMcpServers)
      .where(eq(externalMcpServers.id, serverId));
    if (rows.length === 0) return null;
    return dbRowToRecord(rows[0]);
  }

  async function getServerByKey(key: string): Promise<ExternalMcpServerRecord | null> {
    const rows = await db
      .select()
      .from(externalMcpServers)
      .where(eq(externalMcpServers.key, key));
    if (rows.length === 0) return null;
    return dbRowToRecord(rows[0]);
  }

  return {
    getServer: getServerById,
    getServerByKey,

    isReady(serverId, companyId) {
      const pooled = pool.get(poolKey(serverId, companyId));
      return Boolean(pooled && !pooled.closing);
    },

    configGeneration(serverId) {
      return generationOf(serverId);
    },

    async listTools(serverId, companyId, options) {
      const server = await getServerById(serverId);
      if (!server) throw new Error(`MCP server ${serverId} not found`);
      const pooled = await getOrCreate(server, companyId, options?.deadlineMs);
      const result = await pooled.client.listTools(undefined, {
        timeout: CALL_TIMEOUT_MS,
      });
      return result.tools
        .filter((t) => !isToolBlocked(server, t.name).blocked)
        .map((t) => ({
          name: t.name,
          description: t.description ?? "",
          parametersSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object" },
        }));
    },

    async callTool(serverId, companyId, toolName, args) {
      const server = await getServerById(serverId);
      if (!server) throw new Error(`MCP server ${serverId} not found`);

      const blocked = isToolBlocked(server, toolName);
      if (blocked.blocked) {
        throw new Error(`[ETOOL_BLOCKED] ${blocked.reason}`);
      }

      if (isMutationGated(server, toolName, isLikelyMutationToolName(toolName))) {
        throw new Error(
          `[EDISABLED] mutation tool "${toolName}" is gated by allowMutations on server "${server.key}"`,
        );
      }

      const pooled = await getOrCreate(server, companyId);
      try {
        const result = await pooled.client.callTool(
          {
            name: toolName,
            arguments: (args ?? {}) as Record<string, unknown>,
          },
          undefined,
          { timeout: CALL_TIMEOUT_MS },
        );
        return {
          content: result.content,
          isError: Boolean(result.isError),
        };
      } catch (err) {
        // Rebuild the client on the next call only when the connection is
        // broken. A server that answered with an error, for instance about a
        // tool it no longer has, is still connected and stays pooled.
        const connectionLost = isConnectionError(err);
        log.warn(
          {
            serverKey: server.key,
            companyId,
            toolName,
            connectionLost,
            err: err instanceof Error ? err.message : String(err),
          },
          "external mcp tool call failed",
        );
        if (connectionLost) await evictByKey(poolKey(serverId, companyId), "call-error");
        throw err;
      }
    },

    async evict(serverId, companyId) {
      if (companyId) {
        // One client (the test-connect probe). No settings changed, so what
        // callers know about the server stays valid.
        await evictByKey(poolKey(serverId, companyId), "explicit-evict");
        return;
      }
      // Settings changed: invalidate downstream discovery caches for this
      // server only. A connect still starting with the old settings leaves
      // the in-flight map, so later callers start afresh, and is closed
      // when it lands (see beginConnect).
      generations.set(serverId, generationOf(serverId) + 1);
      const prefix = `${serverId}::`;
      for (const key of Array.from(connecting.keys())) {
        if (key.startsWith(prefix)) connecting.delete(key);
      }
      const keys = Array.from(pool.keys()).filter((k) => k.startsWith(prefix));
      await Promise.all(keys.map((k) => evictByKey(k, "explicit-evict-all")));
    },

    async shutdown() {
      shuttingDown = true;
      // Clients still starting too: a warm-up begun at boot can still be
      // bringing a gateway up when Paperclip is asked to stop. A connect
      // that lands after this is closed by beginConnect.
      const stillStarting = Array.from(starting);
      starting.clear();
      // Side by side: closing a stdio child can take several seconds.
      await Promise.all([
        ...Array.from(pool.keys()).map((k) => evictByKey(k, "shutdown")),
        ...stillStarting.map((client) => closeClient(client, "starting", "shutdown")),
      ]);
    },
  };
}
