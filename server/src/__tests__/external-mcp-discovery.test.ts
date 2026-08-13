/**
 * Unit tests for external-MCP tool discovery, the path that runs before
 * every agent turn and therefore decides how long a reply takes to start.
 *
 * Regression context: discovery queried servers one at a time and waited out
 * each one's full connect budget with no caching. A Docker MCP Gateway that
 * could not finish its handshake added a flat 60s to every single Clippy
 * turn, forever, because nothing remembered that it had just failed.
 *
 * These tests use a fake manager so they assert the discovery policy itself
 * (concurrency, deadline, cool-off, caching) with no child processes and no
 * real waiting. The manager's own connect behaviour is covered against a real
 * stdio server in `external-mcp-integration.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { externalMcpServers } from "@paperclipai/db";
import {
  createExternalMcpToolSource,
  type ExternalMcpToolSource,
} from "../services/external-mcp-tool-source.js";
import {
  ExternalMcpWarmingError,
  type ExternalMcpServerManager,
  type ExternalMcpToolDescriptor,
} from "../services/external-mcp-server-manager.js";

const COMPANY = "11111111-1111-1111-1111-111111111111";

type ServerRow = typeof externalMcpServers.$inferSelect;

function makeRow(key: string, overrides: Partial<ServerRow> = {}): ServerRow {
  return {
    id: `id-${key}`,
    key,
    displayName: `${key} MCP`,
    description: null,
    transport: "stdio",
    command: "node",
    args: [],
    url: null,
    envBindings: {},
    headerBindings: {},
    allowedCompanies: [COMPANY],
    allowMutations: false,
    writeAllowList: [],
    toolAllowList: [],
    toolDenyList: [],
    lastError: null,
    createdByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ServerRow;
}

/** Minimal stand-in for the drizzle chain `listServers` uses. */
function fakeDb(rows: ServerRow[]) {
  return {
    select: () => ({ from: async () => rows }),
  } as never;
}

interface FakeManagerOptions {
  listTools: ExternalMcpServerManager["listTools"];
  isReady?: ExternalMcpServerManager["isReady"];
  generation?: () => number;
}

function fakeManager(options: FakeManagerOptions): ExternalMcpServerManager {
  return {
    getServer: async () => null,
    getServerByKey: async () => null,
    listTools: options.listTools,
    isReady: options.isReady ?? (() => false),
    configGeneration: options.generation ?? (() => 0),
    callTool: async () => ({ content: [], isError: false }),
    evict: async () => {},
    shutdown: async () => {},
  };
}

function tool(name: string): ExternalMcpToolDescriptor {
  return { name, description: "", parametersSchema: { type: "object" } };
}

describe("external MCP discovery: one slow server must not stall the turn", () => {
  let source: ExternalMcpToolSource;

  it("queries servers concurrently, not one after another", async () => {
    // Each server blocks until BOTH have been entered. Serial discovery can
    // never satisfy that and would hang; concurrent discovery sails through.
    let entered = 0;
    let release!: () => void;
    const bothEntered = new Promise<void>((resolve) => {
      release = resolve;
    });

    source = createExternalMcpToolSource(
      fakeDb([makeRow("alpha"), makeRow("beta")]),
      fakeManager({
        listTools: async (serverId) => {
          entered += 1;
          if (entered === 2) release();
          await bothEntered;
          return [tool(`${serverId}-tool`)];
        },
      }),
    );

    const tools = await source.listToolsForCompany(COMPANY);
    expect(entered).toBe(2);
    expect(tools.map((t) => t.namespacedName).sort()).toEqual([
      "mcp:alpha:id-alpha-tool",
      "mcp:beta:id-beta-tool",
    ]);
  });

  it("returns the healthy server's tools when another is still warming", async () => {
    source = createExternalMcpToolSource(
      fakeDb([makeRow("slow"), makeRow("healthy")]),
      fakeManager({
        listTools: async (serverId, _companyId, opts) => {
          if (serverId === "id-slow") {
            // What the real manager does once deadlineMs elapses.
            throw new ExternalMcpWarmingError("slow", opts?.deadlineMs ?? 0);
          }
          return [tool("ping")];
        },
      }),
    );

    const tools = await source.listToolsForCompany(COMPANY);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.namespacedName).toBe("mcp:healthy:ping");
  });

  it("passes a discovery deadline for cold servers and none for pooled ones", async () => {
    const seen: Array<number | undefined> = [];
    source = createExternalMcpToolSource(
      fakeDb([makeRow("alpha")]),
      fakeManager({
        // Already connected, so there is no cold start left to guard against.
        isReady: () => true,
        listTools: async (_serverId, _companyId, opts) => {
          seen.push(opts?.deadlineMs);
          return [tool("ping")];
        },
      }),
    );
    await source.listToolsForCompany(COMPANY);
    expect(seen).toEqual([undefined]);

    const coldSeen: Array<number | undefined> = [];
    const cold = createExternalMcpToolSource(
      fakeDb([makeRow("alpha")]),
      fakeManager({
        isReady: () => false,
        listTools: async (_serverId, _companyId, opts) => {
          coldSeen.push(opts?.deadlineMs);
          return [tool("ping")];
        },
      }),
    );
    await cold.listToolsForCompany(COMPANY);
    expect(coldSeen[0]).toBeGreaterThan(0);
  });
});

describe("external MCP discovery: a failing server is not re-paid every turn", () => {
  it("stops asking a server that missed its deadline (cool-off)", async () => {
    const listTools = vi.fn(async () => {
      throw new ExternalMcpWarmingError("slow", 5_000);
    });
    const source = createExternalMcpToolSource(
      fakeDb([makeRow("slow")]),
      fakeManager({ listTools }),
    );

    await source.listToolsForCompany(COMPANY);
    await source.listToolsForCompany(COMPANY);
    await source.listToolsForCompany(COMPANY);

    // Three turns, one attempt. The other two skipped the wait entirely.
    expect(listTools).toHaveBeenCalledTimes(1);
  });

  it("cools off on a hard error too, not just on a warming timeout", async () => {
    const listTools = vi.fn(async () => {
      throw new Error("MCP error -32000: Connection closed");
    });
    const source = createExternalMcpToolSource(
      fakeDb([makeRow("broken")]),
      fakeManager({ listTools }),
    );

    await source.listToolsForCompany(COMPANY);
    const tools = await source.listToolsForCompany(COMPANY);

    expect(listTools).toHaveBeenCalledTimes(1);
    expect(tools).toEqual([]);
  });

  it("picks a server back up as soon as it finishes warming, ignoring the cool-off", async () => {
    let ready = false;
    const listTools = vi.fn(async () => {
      if (!ready) throw new ExternalMcpWarmingError("slow", 5_000);
      return [tool("ping")];
    });
    const source = createExternalMcpToolSource(
      fakeDb([makeRow("slow")]),
      fakeManager({ listTools, isReady: () => ready }),
    );

    expect(await source.listToolsForCompany(COMPANY)).toEqual([]);
    // Cool-off is active, so without the readiness check this would stay empty
    // for a full minute after the background connect landed.
    expect(await source.listToolsForCompany(COMPANY)).toEqual([]);

    ready = true;
    const tools = await source.listToolsForCompany(COMPANY);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.namespacedName).toBe("mcp:slow:ping");
  });
});

describe("external MCP discovery: caching", () => {
  let generation = 0;

  beforeEach(() => {
    generation = 0;
  });

  it("serves repeat turns from cache instead of re-listing", async () => {
    const listTools = vi.fn(async () => [tool("ping")]);
    const source = createExternalMcpToolSource(
      fakeDb([makeRow("alpha")]),
      fakeManager({ listTools, generation: () => generation }),
    );

    await source.listToolsForCompany(COMPANY);
    await source.listToolsForCompany(COMPANY);
    expect(listTools).toHaveBeenCalledTimes(1);
  });

  it("drops the cache when operator config changes", async () => {
    const listTools = vi.fn(async () => [tool("ping")]);
    const source = createExternalMcpToolSource(
      fakeDb([makeRow("alpha")]),
      fakeManager({ listTools, generation: () => generation }),
    );

    await source.listToolsForCompany(COMPANY);
    expect(listTools).toHaveBeenCalledTimes(1);

    // An evict (server edited or deleted) bumps the manager's generation.
    generation = 1;
    await source.listToolsForCompany(COMPANY);
    expect(listTools).toHaveBeenCalledTimes(2);
  });

  it("keeps caches separate per company", async () => {
    const otherCompany = "22222222-2222-2222-2222-222222222222";
    const listTools = vi.fn(async () => [tool("ping")]);
    const source = createExternalMcpToolSource(
      fakeDb([makeRow("alpha", { allowedCompanies: [COMPANY, otherCompany] })]),
      fakeManager({ listTools }),
    );

    await source.listToolsForCompany(COMPANY);
    await source.listToolsForCompany(otherCompany);
    expect(listTools).toHaveBeenCalledTimes(2);
  });

  it("does not cache the empty result of a skipped server", async () => {
    // A warming server must not poison the cache with an empty tool list.
    // The cool-off is what throttles it, and readiness must be able to win.
    let ready = false;
    const listTools = vi.fn(async () => {
      if (!ready) throw new ExternalMcpWarmingError("slow", 5_000);
      return [tool("ping")];
    });
    const source = createExternalMcpToolSource(
      fakeDb([makeRow("slow")]),
      fakeManager({ listTools, isReady: () => ready }),
    );

    await source.listToolsForCompany(COMPANY);
    ready = true;
    expect(await source.listToolsForCompany(COMPANY)).toHaveLength(1);
  });
});
