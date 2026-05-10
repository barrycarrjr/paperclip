/**
 * Plugin MCP bridge — exposes Paperclip plugin tools to LLM subprocesses
 * (notably Claude Code via the claude_local adapter) over the Model
 * Context Protocol.
 *
 * This sits opposite the External MCP infrastructure:
 *   - `external-mcp-server-manager.ts` makes Paperclip a CLIENT consuming
 *     third-party MCP servers (Notion, Linear, etc.).
 *   - This module makes Paperclip a SERVER — exposing its own plugin
 *     tools so spawned LLM subprocesses can call them via MCP.
 *
 * Architecture
 * ────────────
 *   chat.ts mints a per-session token bound to (companyId, actor)
 *           ↓
 *   adapter (e.g. claude-local execute) writes an mcp-config.json with
 *           url=http://127.0.0.1:<port>/api/internal/mcp/<token>
 *           ↓
 *   spawned Claude Code connects via Streamable HTTP MCP transport
 *           ↓
 *   each tools/list / tools/call hits routes/internal-mcp.ts which calls
 *   handleHttpRequest(token, req, res, body)
 *           ↓
 *   handler resolves token → (companyId, actor), builds a one-shot McpServer
 *   with handlers wired to the plugin tool dispatcher, runs the HTTP
 *   request, returns.
 *
 * Tokens are in-memory only (Map). They survive a single chat session and
 * are revoked when the session ends (or after `TOKEN_TTL_MS` of inactivity).
 *
 * @see packages/adapters/claude-local/src/server/execute.ts — consumer
 * @see services/chat.ts — token issuance
 * @see services/external-mcp-server-manager.ts — sibling (client side)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import type {
  PluginToolDispatcher,
  AgentToolDescriptor,
} from "./plugin-tool-dispatcher.js";
import type { ToolActor } from "./chat-tools.js";
import { logger } from "../middleware/logger.js";

// ─── Token store ──────────────────────────────────────────────────────

/** Default token lifetime — long enough for a multi-turn chat, short
 *  enough that abandoned sessions don't accumulate forever. */
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h

interface BridgeSession {
  token: string;
  /** Chat session that owns this token. Useful for log correlation. */
  chatSessionId: string;
  /** Companies the LLM subprocess can act under. Today we issue
   *  per-(chatSession, single-companyId) tokens; if we ever need cross-
   *  company chat, this grows to a list. */
  companyId: string;
  actor: ToolActor;
  /** When set, plugin-tool calls dispatch under this agent identity instead
   *  of the synthesized `clippy:<userId>` chat-actor identity. Used by
   *  routine/heartbeat-driven runs so plugin tools see the real agentId +
   *  heartbeat runId for audit. */
  agentRunContext?: {
    agentId: string;
    runId: string;
    projectId?: string;
  };
  expiresAt: number;
}

const tokenStore = new Map<string, BridgeSession>();

function isExpired(session: BridgeSession, nowMs: number): boolean {
  return session.expiresAt <= nowMs;
}

function purgeExpired(): void {
  const now = Date.now();
  for (const [token, session] of tokenStore) {
    if (isExpired(session, now)) tokenStore.delete(token);
  }
}

// ─── Public API ───────────────────────────────────────────────────────

export interface MintTokenInput {
  chatSessionId: string;
  companyId: string;
  actor: ToolActor;
  /** Override TTL (ms). Defaults to TOKEN_TTL_MS. */
  ttlMs?: number;
  /** Optional agent-run identity. When set, plugin tool calls run under
   *  this agentId + runId rather than the synthesized chat-actor identity. */
  agentRunContext?: {
    agentId: string;
    runId: string;
    projectId?: string;
  };
}

export interface BridgeStatus {
  /** True iff the bridge is initialized and ready to handle requests. */
  enabled: boolean;
  /** Tokens currently active (not revoked, not expired). */
  activeTokenCount: number;
  /** Cumulative tokens minted since process start. */
  totalMinted: number;
  /** Cumulative tokens revoked since process start (excludes TTL expiry). */
  totalRevoked: number;
  /** Default TTL applied when callers don't override it (ms). */
  defaultTtlMs: number;
}

export interface PluginMcpBridge {
  /**
   * Mint a fresh token for a chat session. Returns the token (UUID-ish).
   * Caller is responsible for revoking via `revokeToken` when the chat
   * session ends; abandoned tokens get GC'd after TTL.
   */
  mintToken(input: MintTokenInput): string;
  /** Revoke a token (e.g. on chat session end). No-op if unknown. */
  revokeToken(token: string): void;
  /** Look up a session for diagnostics; returns null if unknown/expired. */
  resolveToken(token: string): BridgeSession | null;
  /** Read-only status snapshot for the operator-facing health UI. */
  getStatus(): BridgeStatus;
  /**
   * Handle an inbound HTTP MCP request piped from the route layer.
   * `token` comes from the URL; `req`, `res`, `body` are the raw Express
   * I/O. The bridge spins up a one-shot McpServer + transport, handles
   * the request, and tears them down.
   */
  handleHttpRequest(
    token: string,
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
  ): Promise<void>;
}

export interface CreatePluginMcpBridgeOptions {
  pluginToolDispatcher: PluginToolDispatcher;
}

// ─── Implementation ───────────────────────────────────────────────────

export function createPluginMcpBridge(
  options: CreatePluginMcpBridgeOptions,
): PluginMcpBridge {
  const { pluginToolDispatcher } = options;
  const log = logger.child({ service: "plugin-mcp-bridge" });
  let totalMinted = 0;
  let totalRevoked = 0;

  // GC sweeper — cheap; runs every minute.
  const gc = setInterval(purgeExpired, 60_000);
  if (typeof gc.unref === "function") gc.unref();

  return {
    mintToken({ chatSessionId, companyId, actor, ttlMs, agentRunContext }) {
      const token = randomUUID();
      const expiresAt = Date.now() + (ttlMs ?? TOKEN_TTL_MS);
      tokenStore.set(token, { token, chatSessionId, companyId, actor, agentRunContext, expiresAt });
      totalMinted += 1;
      log.debug({ chatSessionId, companyId, expiresAt, agentRunContext: !!agentRunContext }, "minted MCP bridge token");
      return token;
    },

    revokeToken(token) {
      const session = tokenStore.get(token);
      if (!session) return;
      tokenStore.delete(token);
      totalRevoked += 1;
      log.debug(
        { chatSessionId: session.chatSessionId, companyId: session.companyId },
        "revoked MCP bridge token",
      );
    },

    resolveToken(token) {
      const session = tokenStore.get(token);
      if (!session) return null;
      if (isExpired(session, Date.now())) {
        tokenStore.delete(token);
        return null;
      }
      return session;
    },

    getStatus() {
      purgeExpired();
      return {
        enabled: true,
        activeTokenCount: tokenStore.size,
        totalMinted,
        totalRevoked,
        defaultTtlMs: TOKEN_TTL_MS,
      };
    },

    async handleHttpRequest(token, req, res, body) {
      const session = tokenStore.get(token);
      if (!session || isExpired(session, Date.now())) {
        if (session) tokenStore.delete(token);
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Invalid or expired bridge token" },
            id: null,
          }),
        );
        return;
      }

      // Build a fresh McpServer per request. Tool registration is dynamic
      // (depends on which plugin tools are accessible by `session.companyId`
      // right now), so we don't gain much from pooling — and statelessness
      // matches StreamableHTTPServerTransport's stateless mode cleanly.
      const server = new McpServer(
        { name: "paperclip-plugins", version: "0.1.0" },
        { capabilities: { tools: {} } },
      );

      // tools/list — enumerate plugin tools the calling company can use.
      // The dispatcher's listToolsForAgent doesn't filter plugin tools by
      // companyId (only external MCP tools are filtered there); per-tool
      // company isolation is enforced inside the plugin worker via the
      // standard assertCompanyAccess pattern. So we expose all registered
      // plugin tools here and let the worker reject if appropriate.
      server.setRequestHandler(ListToolsRequestSchema, async () => {
        let descriptors: AgentToolDescriptor[] = [];
        try {
          descriptors = await pluginToolDispatcher.listToolsForAgent({
            companyId: session.companyId,
          });
        } catch (err) {
          log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "listToolsForAgent failed in bridge",
          );
          descriptors = [];
        }
        return {
          tools: descriptors.map((d) => ({
            // MCP tool names need to match Claude Code's expected format.
            // The dispatcher emits `<pluginKey>:<toolName>` — rewrite to
            // `<pluginKey>__<toolName>` to match Anthropic's tool-name
            // regex (`^[a-zA-Z0-9_-]{1,64}$`, no colons).
            name: d.name.replace(":", "__"),
            description: `${d.displayName} — ${d.description}`,
            inputSchema: d.parametersSchema,
          })),
        };
      });

      // tools/call — route through the dispatcher with a runContext built
      // from the bridge session.
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const incomingName = request.params.name;
        const namespacedName = incomingName.includes("__")
          ? (() => {
              const idx = incomingName.indexOf("__");
              return (
                incomingName.slice(0, idx) + ":" + incomingName.slice(idx + 2)
              );
            })()
          : incomingName;

        const runContext: ToolRunContext = session.agentRunContext
          ? {
              agentId: session.agentRunContext.agentId,
              runId: session.agentRunContext.runId,
              companyId: session.companyId,
              projectId: session.agentRunContext.projectId ?? "",
              chatSessionId: session.chatSessionId,
            }
          : {
              agentId: `clippy:${session.actor.userId}`,
              runId: randomUUID(),
              companyId: session.companyId,
              projectId: "",
              chatSessionId: session.chatSessionId,
            };

        try {
          const exec = await pluginToolDispatcher.executeTool(
            namespacedName,
            request.params.arguments ?? {},
            runContext,
          );
          if (exec.result.error) {
            return {
              content: [{ type: "text", text: exec.result.error }],
              isError: true,
            };
          }
          const text =
            typeof exec.result.content === "string"
              ? exec.result.content
              : exec.result.data !== undefined
                ? JSON.stringify(exec.result.data)
                : "";
          return {
            content: [{ type: "text", text }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn(
            { tool: namespacedName, err: message },
            "plugin tool execution failed in bridge",
          );
          return {
            content: [{ type: "text", text: message }],
            isError: true,
          };
        }
      });

      // Stateless mode — every HTTP request is independent. Pairs with
      // Claude Code's own MCP client, which dials in fresh per session.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "plugin MCP bridge handle failed",
        );
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: "Internal error" },
              id: null,
            }),
          );
        }
      } finally {
        await transport.close().catch(() => {});
        await server.close().catch(() => {});
      }
    },
  };
}

// ─── Module-level singleton (set once at app startup) ──────────────────

let bridgeInstance: PluginMcpBridge | null = null;

/**
 * Set the singleton bridge instance from `app.ts` so chat.ts and routes
 * can grab it without threading it through every constructor.
 */
export function setPluginMcpBridge(bridge: PluginMcpBridge | null): void {
  bridgeInstance = bridge;
}

/**
 * Read the bridge instance. Returns null if `setPluginMcpBridge` was
 * never called (e.g., in tests that don't wire the full app stack).
 */
export function getPluginMcpBridge(): PluginMcpBridge | null {
  return bridgeInstance;
}
