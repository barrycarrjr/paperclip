/**
 * Internal Plugin MCP Bridge route.
 *
 * Mounts the in-process MCP server at `/api/internal/mcp/:token` so
 * spawned LLM subprocesses (claude_local → Claude Code) can dial in via
 * Streamable HTTP and call plugin tools.
 *
 * Auth is the URL-embedded ephemeral token minted by chat.ts when an
 * agent-mode session boots against an adapter that doesn't natively pass
 * Paperclip's tools list (today: claude_local). The token resolves to
 * `(chatSessionId, companyId, actor)` server-side; the bridge runs each
 * tool call under that scope.
 *
 * @see services/plugin-mcp-bridge.ts
 */

import { Router } from "express";
import { getPluginMcpBridge } from "../services/plugin-mcp-bridge.js";
import { logger } from "../middleware/logger.js";

export function internalMcpRoutes() {
  const router = Router();

  const handler = async (req: import("express").Request, res: import("express").Response) => {
    const bridge = getPluginMcpBridge();
    if (!bridge) {
      res.status(503).json({
        jsonrpc: "2.0",
        error: { code: -32002, message: "Plugin MCP bridge not initialized" },
        id: null,
      });
      return;
    }
    const token = req.params.token;
    if (!token || typeof token !== "string") {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32600, message: "Missing token" },
        id: null,
      });
      return;
    }
    try {
      await bridge.handleHttpRequest(token, req, res, req.body);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err), token: `${token.slice(0, 8)}...` },
        "internal MCP bridge route failed",
      );
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal error" },
          id: null,
        });
      }
    }
  };

  // MCP Streamable HTTP uses POST for client→server messages and GET to
  // open the SSE stream for server→client messages. Both must be routed
  // through the same handler.
  router.post("/internal/mcp/:token", handler);
  router.get("/internal/mcp/:token", handler);
  router.delete("/internal/mcp/:token", handler);

  // Read-only status endpoint for the operator-facing health UI on the
  // External MCP servers page. Anyone with board access can see counts;
  // we deliberately don't expose actual tokens or per-session details.
  router.get("/internal/mcp-bridge/status", (_req, res) => {
    const bridge = getPluginMcpBridge();
    if (!bridge) {
      res.json({
        enabled: false,
        activeTokenCount: 0,
        totalMinted: 0,
        totalRevoked: 0,
        defaultTtlMs: 0,
      });
      return;
    }
    res.json(bridge.getStatus());
  });

  return router;
}
