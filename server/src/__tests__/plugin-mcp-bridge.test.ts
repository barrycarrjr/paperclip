import http from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Db } from "@paperclipai/db";
import { createPluginMcpBridge } from "../services/plugin-mcp-bridge.js";
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
              return Promise.resolve([]);
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
    async executeTool(namespacedName: string) {
      if (namespacedName === "demo:ping") {
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

  beforeEach(async () => {
    const bridge = createPluginMcpBridge({
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
      await bridge.handleHttpRequest(req.params.token, req, res, req.body);
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

  async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
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
});
