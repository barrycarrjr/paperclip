/**
 * The external MCP manager's handling of edits, call errors and shutdown,
 * against a stand-in for the MCP SDK client so a connect lands exactly when
 * the test says. A real child process is used in
 * `external-mcp-integration.test.ts`.
 *
 * Regression context (2026-10-09 review of the start-up warm-up):
 *   - one config generation for all servers meant an edit or a test-connect
 *     on one server wiped what was known about every other server;
 *   - a connect still starting when its server was edited was kept as the
 *     live client when it landed, still running the old command, URL, env
 *     or credentials;
 *   - any failed call closed the client, so asking a just-started gateway
 *     for a tool it no longer had threw away the gateway;
 *   - shutdown only closed connected clients, never ones still starting.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { externalMcpServers } from "@paperclipai/db";
import {
  createExternalMcpServerManager,
  ExternalMcpConfigChangedError,
} from "../services/external-mcp-server-manager.js";
import { createGracefulShutdown } from "../graceful-shutdown.js";

const sdk = vi.hoisted(() => {
  class FakeClient {
    static all: FakeClient[] = [];
    /** When false, a new client stays connecting until the test lands it. */
    static landAtOnce = true;
    static callTool: (name: string) => Promise<unknown> = async () => ({ content: [], isError: false });

    closed = false;
    private settleConnect!: { resolve: () => void; reject: (err: Error) => void };
    private readonly connected: Promise<void>;

    constructor() {
      this.connected = new Promise<void>((resolve, reject) => {
        this.settleConnect = { resolve, reject };
      });
      this.connected.catch(() => {});
      FakeClient.all.push(this);
      if (FakeClient.landAtOnce) this.settleConnect.resolve();
    }

    connect(): Promise<void> {
      return this.connected;
    }

    land(): void {
      this.settleConnect.resolve();
    }

    getServerVersion() {
      return { name: "fake", version: "1.0.0" };
    }

    async listTools() {
      return { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }] };
    }

    callTool(params: { name: string }) {
      return FakeClient.callTool(params.name);
    }

    async close(): Promise<void> {
      this.closed = true;
      this.settleConnect.reject(new Error("Connection closed"));
    }
  }

  class FakeStdioTransport {
    readonly stderr = null;
    constructor(readonly options: unknown) {}
  }

  return { FakeClient, FakeStdioTransport };
});

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: sdk.FakeClient }));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: sdk.FakeStdioTransport,
}));

const SERVER = "11111111-aaaa-4aaa-8aaa-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const OTHER_COMPANY = "33333333-3333-4333-8333-333333333333";

function serverRow(): typeof externalMcpServers.$inferSelect {
  return {
    id: SERVER,
    key: "docker",
    displayName: "Docker MCP gateway",
    description: null,
    transport: "stdio",
    command: "docker",
    args: ["mcp", "gateway", "run"],
    url: null,
    envBindings: {},
    headerBindings: {},
    allowedCompanies: ["*"],
    allowMutations: false,
    writeAllowList: [],
    toolAllowList: [],
    toolDenyList: [],
    lastError: null,
    createdByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as typeof externalMcpServers.$inferSelect;
}

/** Answers the manager's one read: the server record by id. */
function fakeDb() {
  return {
    select: () => ({ from: () => ({ where: async () => [serverRow()] }) }),
  } as never;
}

/** Waits until this many clients exist and the newest has started connecting. */
async function clientsStarted(count: number) {
  await vi.waitFor(() => expect(sdk.FakeClient.all).toHaveLength(count));
  await new Promise<void>((resolve) => setImmediate(resolve));
  return sdk.FakeClient.all;
}

beforeEach(() => {
  sdk.FakeClient.all = [];
  sdk.FakeClient.landAtOnce = true;
  sdk.FakeClient.callTool = async () => ({ content: [], isError: false });
});

describe("external MCP manager: operator edits", () => {
  it("keeps a separate edit count for each server, and a test-connect is not an edit", async () => {
    const manager = createExternalMcpServerManager(fakeDb());

    await manager.evict("server-a");
    expect(manager.configGeneration("server-a")).toBe(1);
    expect(manager.configGeneration("server-b")).toBe(0);

    // The test-connect route closes its probe client this way.
    await manager.evict("server-a", COMPANY);
    expect(manager.configGeneration("server-a")).toBe(1);
  });

  it("closes a connect that finishes after its server was edited instead of keeping it", async () => {
    sdk.FakeClient.landAtOnce = false;
    const manager = createExternalMcpServerManager(fakeDb());
    const beforeEdit = manager.listTools(SERVER, COMPANY);
    const [startedWithOldSettings] = await clientsStarted(1);

    await manager.evict(SERVER);
    startedWithOldSettings!.land();

    await expect(beforeEdit).rejects.toBeInstanceOf(ExternalMcpConfigChangedError);
    expect(startedWithOldSettings!.closed).toBe(true);
    expect(manager.isReady(SERVER, COMPANY)).toBe(false);
  });

  it("starts a fresh connect for a call made after the edit rather than joining the old one", async () => {
    sdk.FakeClient.landAtOnce = false;
    const manager = createExternalMcpServerManager(fakeDb());
    const beforeEdit = manager.listTools(SERVER, COMPANY);
    beforeEdit.catch(() => {});
    await clientsStarted(1);

    await manager.evict(SERVER);
    const afterEdit = manager.listTools(SERVER, COMPANY);
    const [startedWithOldSettings, startedWithNewSettings] = await clientsStarted(2);

    startedWithNewSettings!.land();
    startedWithOldSettings!.land();

    expect((await afterEdit).map((tool) => tool.name)).toEqual(["echo"]);
    await expect(beforeEdit).rejects.toBeInstanceOf(ExternalMcpConfigChangedError);
    expect(manager.isReady(SERVER, COMPANY)).toBe(true);
    expect(startedWithNewSettings!.closed).toBe(false);
    expect(startedWithOldSettings!.closed).toBe(true);
  });
});

describe("external MCP manager: a failed tool call", () => {
  it("keeps the client when the server answers with an error, such as an unknown tool", async () => {
    const manager = createExternalMcpServerManager(fakeDb());
    await manager.listTools(SERVER, COMPANY);
    sdk.FakeClient.callTool = async (name) => {
      throw new McpError(ErrorCode.InvalidParams, `Tool ${name} not found`);
    };

    await expect(manager.callTool(SERVER, COMPANY, "gone_tool", {})).rejects.toThrow(
      /gone_tool not found/,
    );

    expect(manager.isReady(SERVER, COMPANY)).toBe(true);
    expect(sdk.FakeClient.all[0]!.closed).toBe(false);
  });

  it("closes the client when the connection itself is lost, so the next call reconnects", async () => {
    const lost = [
      new McpError(ErrorCode.ConnectionClosed, "Connection closed"),
      new McpError(ErrorCode.RequestTimeout, "Request timed out"),
      new Error("Not connected"),
    ];
    for (const [index, err] of lost.entries()) {
      const manager = createExternalMcpServerManager(fakeDb());
      await manager.listTools(SERVER, COMPANY);
      sdk.FakeClient.callTool = async () => {
        throw err;
      };

      await expect(manager.callTool(SERVER, COMPANY, "echo", {})).rejects.toBe(err);

      expect(manager.isReady(SERVER, COMPANY)).toBe(false);
      expect(sdk.FakeClient.all[index]!.closed).toBe(true);
    }
  });
});

describe("external MCP manager: shutdown", () => {
  it("closes warmed clients and ones still starting", async () => {
    const manager = createExternalMcpServerManager(fakeDb());
    await manager.listTools(SERVER, COMPANY);
    sdk.FakeClient.landAtOnce = false;
    const stillStarting = manager.listTools(SERVER, OTHER_COMPANY);
    stillStarting.catch(() => {});
    const [warmed, starting] = await clientsStarted(2);

    await manager.shutdown();

    expect(warmed!.closed).toBe(true);
    expect(starting!.closed).toBe(true);
    expect(manager.isReady(SERVER, COMPANY)).toBe(false);
    await expect(stillStarting).rejects.toThrow();
  });

  it("a graceful stop closes the warmed clients before the database stops and the process exits", async () => {
    const manager = createExternalMcpServerManager(fakeDb());
    await manager.listTools(SERVER, COMPANY);
    const [warmed] = sdk.FakeClient.all;

    const steps: string[] = [];
    const shutdown = createGracefulShutdown({
      externalMcpServerManager: manager,
      stopEmbeddedPostgres: async () => {
        steps.push(warmed!.closed ? "database, after the gateway closed" : "database, gateway still open");
      },
      exit: (code) => {
        steps.push(`exit ${code}`);
      },
    });
    await shutdown("SIGTERM");

    expect(warmed!.closed).toBe(true);
    expect(steps).toEqual(["database, after the gateway closed", "exit 0"]);
  });
});
