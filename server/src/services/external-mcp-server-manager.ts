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
import {
  externalMcpSecretsService,
  type ExternalMcpSecretsService,
} from "./external-mcp-secrets.js";
import { logger } from "../middleware/logger.js";

const IDLE_TIMEOUT_MS = 5 * 60_000;
const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 120_000;

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
  /** Connect (or reuse) and list the server's tools for the calling company. */
  listTools(serverId: string, companyId: string): Promise<ExternalMcpToolDescriptor[]>;
  /** Call a tool by its bare name (not namespaced). Mutation gating happens here. */
  callTool(
    serverId: string,
    companyId: string,
    toolName: string,
    args: unknown,
  ): Promise<ExternalMcpCallResult>;
  /** Tear down a (server, company) client. Used after config update or delete. */
  evict(serverId: string, companyId?: string): Promise<void>;
  /** Tear down everything. Called during graceful shutdown. */
  shutdown(): Promise<void>;
}

export interface ExternalMcpServerManagerOptions {
  idleTimeoutMs?: number;
}

export function createExternalMcpServerManager(
  db: Db,
  options: ExternalMcpServerManagerOptions = {},
): ExternalMcpServerManager {
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const log = logger.child({ service: "external-mcp-server-manager" });
  const secrets: ExternalMcpSecretsService = externalMcpSecretsService(db);

  // Pool keyed by `${serverId}::${companyId}`.
  const pool = new Map<string, PooledClient>();

  function poolKey(serverId: string, companyId: string): string {
    return `${serverId}::${companyId}`;
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
    try {
      await pooled.client.close();
    } catch (err) {
      log.warn({ key, reason, err: err instanceof Error ? err.message : String(err) }, "client close failed");
    }
    log.debug({ key, reason }, "external mcp client evicted");
  }

  async function buildTransport(
    server: ExternalMcpServerRecord,
    resolved: Awaited<ReturnType<ExternalMcpSecretsService["resolveBindings"]>>,
  ): Promise<{
    transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
    cleanup?: () => Promise<void>;
  }> {
    if (server.transport === "stdio") {
      if (!server.command) {
        throw new Error(`MCP server "${server.key}" is stdio transport but has no command`);
      }
      const transport = new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env: resolved.env,
        stderr: "pipe",
      });
      // Capture stderr; never log resolved env values.
      transport.stderr?.on("data", (chunk) => {
        log.debug(
          { serverKey: server.key, stderr: String(chunk).slice(0, 1024) },
          "stdio mcp stderr",
        );
      });
      return { transport };
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

    const { transport } = await buildTransport(server, resolved);

    const connectPromise = client.connect(transport);
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`MCP connect timed out after ${CONNECT_TIMEOUT_MS}ms`)),
        CONNECT_TIMEOUT_MS,
      ).unref?.();
    });
    await Promise.race([connectPromise, timeoutPromise]);

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

  async function getOrCreate(
    server: ExternalMcpServerRecord,
    companyId: string,
  ): Promise<PooledClient> {
    const key = poolKey(server.id, companyId);
    let pooled = pool.get(key);
    if (pooled && !pooled.closing) {
      pooled.lastUsedAt = Date.now();
      scheduleIdleEviction(key, pooled);
      return pooled;
    }
    pooled = await connect(server, companyId);
    pool.set(key, pooled);
    scheduleIdleEviction(key, pooled);
    log.info({ serverKey: server.key, companyId }, "external mcp client connected");
    return pooled;
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

    async listTools(serverId, companyId) {
      const server = await getServerById(serverId);
      if (!server) throw new Error(`MCP server ${serverId} not found`);
      const pooled = await getOrCreate(server, companyId);
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
        // On certain transport-level errors, evict and retry once on next call.
        log.warn(
          {
            serverKey: server.key,
            companyId,
            toolName,
            err: err instanceof Error ? err.message : String(err),
          },
          "external mcp tool call failed",
        );
        await evictByKey(poolKey(serverId, companyId), "call-error");
        throw err;
      }
    },

    async evict(serverId, companyId) {
      if (companyId) {
        await evictByKey(poolKey(serverId, companyId), "explicit-evict");
        return;
      }
      const prefix = `${serverId}::`;
      const keys = Array.from(pool.keys()).filter((k) => k.startsWith(prefix));
      for (const k of keys) {
        await evictByKey(k, "explicit-evict-all");
      }
    },

    async shutdown() {
      const keys = Array.from(pool.keys());
      for (const k of keys) {
        await evictByKey(k, "shutdown");
      }
    },
  };
}
