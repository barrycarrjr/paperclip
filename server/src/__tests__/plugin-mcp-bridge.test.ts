import http from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Db } from "@paperclipai/db";
import { registerChatToolInteractions } from "../services/chat-tool-interactions.js";
import { chatPermissions } from "../services/chat-permissions.js";
import { createPluginMcpBridge } from "../services/plugin-mcp-bridge.js";
import { loadPersonalCompanyIndex, rememberPersonalCompany } from "../services/personal-companies.js";
import type {
  AgentToolDescriptor,
  PluginToolDispatcher,
} from "../services/plugin-tool-dispatcher.js";

// A db stub whose reads resolve to empty arrays — enough for the built-in
// tools' wiring/authz path without a real database. The bridge tests here
// exercise tool *routing*, not query results.
function createDbStub(): Db {
  const stub = {
    select() {
      return {
        from() {
          return {
            where() {
              const rows = Promise.resolve([]);
              return Object.assign(rows, { orderBy: () => ({ limit: () => rows }) });
            },
            limit() {
              return Promise.resolve([]);
            },
          };
        },
      };
    },
  } as unknown as Db;
  return stub;
}

// Minimal dispatcher exposing one plugin tool ("demo:ping") so we can prove
// the plugin path still works alongside the newly-bridged built-in tools.
function createDispatcherStub(): PluginToolDispatcher {
  const descriptor: AgentToolDescriptor = {
    name: "demo:ping",
    displayName: "Ping",
    description: "Returns pong",
    parametersSchema: { type: "object", properties: {} },
    pluginId: "demo",
  };
  const stub = {
    async listToolsForAgent(): Promise<AgentToolDescriptor[]> {
      return [descriptor];
    },
    async executeTool(namespacedName: string, _params: unknown, run: { userId?: string | null }, options?: { requestUserConfirmation?: (name: string, input: unknown) => Promise<boolean> }) {
      if (namespacedName === "demo:ping") {
        if (options?.requestUserConfirmation && run.userId === "u1") {
          const confirmed = await options.requestUserConfirmation(namespacedName, { target: "pc.example.local" });
          if (confirmed) return { result: { content: "confirmed pong" } };
        }
        return { result: { content: "pong" } };
      }
      return { result: { error: `Unknown plugin tool: ${namespacedName}` } };
    },
  } as unknown as PluginToolDispatcher;
  return stub;
}

describe("plugin MCP bridge — built-in chat tools", () => {
  let server: http.Server;
  let baseUrl: string;
  let token: string;
  let bridge: ReturnType<typeof createPluginMcpBridge>;

  beforeEach(async () => {
    await loadPersonalCompanyIndex(createDbStub());
    bridge = createPluginMcpBridge({
      pluginToolDispatcher: createDispatcherStub(),
      db: createDbStub(),
    });
    token = bridge.mintToken({
      chatSessionId: "sess-1",
      companyId: "11111111-1111-1111-1111-111111111111",
      actor: {
        userId: "u1",
        isInstanceAdmin: true,
        companyIds: ["11111111-1111-1111-1111-111111111111"],
      },
    });

    const app = express();
    app.use(express.json());
    const handler = async (req: express.Request, res: express.Response) => {
      const sessionToken = req.params.token;
      if (typeof sessionToken !== "string") throw new Error("Missing bridge token");
      await bridge.handleHttpRequest(sessionToken, req, res, req.body);
    };
    app.post("/api/internal/mcp/:token", handler);
    app.get("/api/internal/mcp/:token", handler);
    app.delete("/api/internal/mcp/:token", handler);

    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    baseUrl = `http://127.0.0.1:${addr.port}/api/internal/mcp/${token}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function withClient<T>(fn: (client: Client) => Promise<T>, sessionToken = token): Promise<T> {
    const url = new URL(baseUrl);
    url.pathname = `/api/internal/mcp/${sessionToken}`;
    const transport = new StreamableHTTPClientTransport(url);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(transport);
    try {
      return await fn(client);
    } finally {
      await client.close();
    }
  }

  it("tools/list exposes built-in chat tools alongside plugin tools", async () => {
    const names = await withClient(async (client) => {
      const { tools } = await client.listTools();
      return tools.map((t) => t.name);
    });

    // The regression: these built-ins used to be dropped for adapter-mode
    // Clippy because the bridge only served plugin tools.
    for (const builtIn of [
      "create_reminder",
      "list_reminders",
      "cancel_reminder",
      "create_issue",
      "broadcast_directive",
      "list_companies",
    ]) {
      expect(names, `expected built-in tool ${builtIn}`).toContain(builtIn);
    }
    // Plugin tool still bridged, with the colon rewritten to "__".
    expect(names).toContain("demo__ping");
    // Built-in names never carry the plugin separator.
    for (const n of names) {
      if (n.startsWith("demo")) continue;
      if (["create_reminder", "list_reminders", "cancel_reminder", "create_issue", "broadcast_directive", "list_companies"].includes(n)) {
        expect(n.includes("__")).toBe(false);
      }
    }
  });

  it("built-in tool inputSchema is carried through as a JSON-schema object", async () => {
    const schemaType = await withClient(async (client) => {
      const { tools } = await client.listTools();
      const reminder = tools.find((t) => t.name === "create_reminder");
      return reminder?.inputSchema?.type;
    });
    expect(schemaType).toBe("object");
  });

  it("tools/call routes a built-in through executeChatTool (zod validation fires)", async () => {
    const res = await withClient((client) =>
      // Empty title fails create_issue's zod min(1) — proves the call was
      // routed into the built-in tool, not the plugin dispatcher.
      client.callTool({ name: "create_issue", arguments: { title: "" } }),
    );
    expect(res.isError).toBe(true);
    const text = Array.isArray(res.content) ? res.content[0]?.text ?? "" : "";
    expect(text).toMatch(/Invalid input/);
  });

  it("tools/call still routes plugin tools through the dispatcher", async () => {
    const text = await withClient(async (client) => {
      const res = await client.callTool({ name: "demo__ping", arguments: {} });
      return Array.isArray(res.content) ? res.content[0]?.text ?? "" : "";
    });
    expect(text).toBe("pong");
  });

  it("binds Personal access to the agent run, rather than a user id or supplied actor field", async () => {
    const personalCompanyId = "22222222-2222-4222-8222-222222222222";
    rememberPersonalCompany(personalCompanyId, "owner-1");
    const actor = { userId: "agent:a1", isInstanceAdmin: false, companyIds: [personalCompanyId] };
    const agentToken = bridge.mintToken({
      chatSessionId: "heartbeat:personal-run", companyId: personalCompanyId, actor,
      agentRunContext: { agentId: "a1", runId: "personal-run" },
    });
    const allowed = await withClient(client => client.callTool({ name: "list_issues", arguments: {} }), agentToken);
    expect(allowed.isError).not.toBe(true);
    expect(allowed.content).toEqual([{ type: "text", text: JSON.stringify({ companyId: personalCompanyId, issues: [] }) }]);

    const impersonatorToken = bridge.mintToken({
      chatSessionId: "chat:impersonator", companyId: personalCompanyId,
      actor: { ...actor, agentCompanyId: personalCompanyId },
    });
    const outsideAgentToken = bridge.mintToken({
      chatSessionId: "heartbeat:hq-run", companyId: "11111111-1111-1111-1111-111111111111",
      actor: { ...actor, isInstanceAdmin: true },
      agentRunContext: { agentId: "hq-agent", runId: "hq-run" },
    });
    for (const sessionToken of [impersonatorToken, outsideAgentToken]) {
      const refused = await withClient(client => client.callTool({
        name: "list_issues", arguments: { companyId: personalCompanyId },
      }), sessionToken);
      expect(refused.isError).toBe(true);
      expect(refused.content).toEqual([{ type: "text", text: "This is someone's personal company" }]);
    }
  });

  it("refuses a viewer's chat the plugin tools and the changes the person could not make, but not an agent run", async () => {
    const company = "11111111-1111-1111-1111-111111111111";
    const executeTool = vi.fn(async () => ({ result: { content: "pong" } }));
    const bridge = createPluginMcpBridge({
      pluginToolDispatcher: { ...createDispatcherStub(), executeTool } as unknown as PluginToolDispatcher,
      db: createDbStub(),
    });
    const viewerToken = bridge.mintToken({
      chatSessionId: "sess-viewer",
      companyId: company,
      actor: {
        userId: "u-viewer",
        isInstanceAdmin: false,
        companyIds: [company],
        memberships: [{ companyId: company, membershipRole: "viewer", status: "active" }],
      },
    });
    // An agent run has no person behind it, so the viewer rule does not apply.
    const agentToken = bridge.mintToken({
      chatSessionId: "heartbeat:run-1",
      companyId: company,
      actor: { userId: "agent:a1", isInstanceAdmin: false, companyIds: [company] },
      agentRunContext: { agentId: "a1", runId: "run-1" },
    });
    const app = express();
    app.use(express.json());
    app.post("/mcp/:token", async (req, res) => {
      await bridge.handleHttpRequest(req.params.token, req, res, req.body);
    });
    const bridgeServer = http.createServer(app);
    await new Promise<void>((resolve) => bridgeServer.listen(0, "127.0.0.1", resolve));
    const addr = bridgeServer.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    const call = async (token: string, name: string, args: Record<string, unknown>) => {
      const client = new Client({ name: "test", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${addr.port}/mcp/${token}`)));
      try {
        return await client.callTool({ name, arguments: args });
      } finally {
        await client.close();
      }
    };
    try {
      const plugin = await call(viewerToken, "demo__ping", {});
      expect(plugin.isError).toBe(true);
      expect(plugin.content).toEqual([{ type: "text", text: "Viewer access is read-only" }]);
      expect(executeTool).not.toHaveBeenCalled();

      const change = await call(viewerToken, "create_issue", { title: "Chase the invoices" });
      expect(change.isError).toBe(true);
      expect(change.content).toEqual([{ type: "text", text: "Viewer access is read-only" }]);

      const agentRun = await call(agentToken, "demo__ping", {});
      expect(agentRun.content).toEqual([{ type: "text", text: "pong" }]);
      expect(executeTool).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve) => bridgeServer.close(() => resolve()));
    }
  });

  it("adapter MCP tools share the live inline consent prompt and report their result", async () => {
    const types: string[] = [];
    const cleanup = registerChatToolInteractions("sess-1", (event) => {
      types.push(event.type);
      if (event.type === "permission_required") {
        expect(event.input).toEqual({ target: "pc.example.local" });
        chatPermissions.resolve("sess-1", event.toolUseId, "approve");
      }
    });
    try {
      const result = await withClient(client => client.callTool({ name: "demo__ping", arguments: {} }));
      expect(result.content).toEqual([{ type: "text", text: "confirmed pong" }]);
      expect(types).toEqual(["tool_use_block", "tool_use_block", "permission_required", "tool_result_block", "tool_result_block"]);
    } finally { cleanup(); }
  });
});
