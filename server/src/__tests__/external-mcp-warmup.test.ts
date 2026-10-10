/**
 * External MCP servers are connected when Paperclip starts, and a server that
 * has listed its tools keeps them while it reconnects.
 *
 * Regression context (2026-10-09): after a restart, and again after every
 * five-minute idle timeout, the next turn found Docker's MCP gateway cold (it
 * takes 20 to 70 seconds to start) and left its tools out. A resumed Claude
 * Code session announced the missing tools as "no longer available (their
 * MCP server disconnected)", so Clippy told people its tools were
 * disconnected while they worked.
 *
 * The fake manager keeps the real manager's rules that matter here: one
 * client per (server, company), connects that land when the test says so, a
 * discovery deadline that gives up with ExternalMcpWarmingError while the
 * connect carries on, and an operator edit that moves only that server's
 * config generation, closes its clients and lets later callers start a fresh
 * connect. A connect that started before an edit still answers with the
 * tools of the settings it started with: that is the late answer the tool
 * source has to refuse to record. The real manager is covered in
 * `external-mcp-server-manager.test.ts` and
 * `external-mcp-integration.test.ts`.
 */

import http from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { companies, externalMcpServers } from "@paperclipai/db";
import { startPluginRuntime } from "../plugin-runtime-startup.js";
import {
  createExternalMcpToolSource,
  type ExternalMcpToolSource,
} from "../services/external-mcp-tool-source.js";
import {
  ExternalMcpConfigChangedError,
  ExternalMcpWarmingError,
  type ExternalMcpServerManager,
} from "../services/external-mcp-server-manager.js";
import { createPluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import { createPluginMcpBridge, type PluginMcpBridge } from "../services/plugin-mcp-bridge.js";

const HQ = "11111111-1111-4111-8111-111111111111";
const BUREAU = "22222222-2222-4222-8222-222222222222";
const RETIRED = "33333333-3333-4333-8333-333333333333";
const PAUSED = "44444444-4444-4444-8444-444444444444";

interface CompanyRow {
  id: string;
  status: string;
  isPortfolioRoot: boolean;
  createdAt: Date;
}

const COMPANIES: CompanyRow[] = [
  { id: RETIRED, status: "archived", isPortfolioRoot: false, createdAt: new Date("2025-01-01T00:00:00Z") },
  { id: BUREAU, status: "active", isPortfolioRoot: false, createdAt: new Date("2025-02-01T00:00:00Z") },
  { id: PAUSED, status: "paused", isPortfolioRoot: false, createdAt: new Date("2025-03-01T00:00:00Z") },
  { id: HQ, status: "active", isPortfolioRoot: true, createdAt: new Date("2026-09-01T00:00:00Z") },
];

/** A binding resolved from each company's own vault. */
const COMPANY_SECRET = { HA_TOKEN: { type: "secret_ref", secretName: "HA_TOKEN" } };

type ServerRow = typeof externalMcpServers.$inferSelect;

function makeRow(key: string, overrides: Partial<ServerRow> = {}): ServerRow {
  return {
    id: `id-${key}`,
    key,
    displayName: `${key} MCP`,
    description: null,
    transport: "stdio",
    command: "docker",
    args: [],
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
    ...overrides,
  } as ServerRow;
}

/** Docker's MCP gateway as registered on the instance: every company, no secrets. */
const dockerGateway = () => makeRow("docker");
/** A server that signs in with each company's own secret. */
const homeAssistant = () =>
  makeRow("home", { allowedCompanies: [BUREAU], envBindings: COMPANY_SECRET as never });

/** Answers the two reads the tool source makes: the server registry and the companies. */
function fakeDb(servers: ServerRow[], companyRows: CompanyRow[] = COMPANIES) {
  return {
    select: () => ({
      from: async (table: unknown) => (table === companies ? companyRows : servers),
    }),
  } as never;
}

interface Attempt {
  key: string;
  /** The server's settings generation when this connect started. */
  generation: number;
  settled: boolean;
  promise: Promise<void>;
  resolve(): void;
  reject(err: Error): void;
}

type ToolsFor = string[] | ((generation: number) => string[]);

function fakeManager(toolsByServer: Record<string, ToolsFor>, options: { autoLand?: boolean } = {}) {
  const generations = new Map<string, number>();
  // Live clients, with the settings generation each was started with.
  const connected = new Map<string, number>();
  const connecting = new Map<string, Attempt>();
  const attempts: Attempt[] = [];
  const started: string[] = [];
  const calls: Array<{ key: string; deadlineMs: number | undefined }> = [];
  const state = { autoLand: options.autoLand ?? false };

  const generationOf = (serverId: string) => generations.get(serverId) ?? 0;
  const serverOf = (key: string) => key.split("::")[0]!;
  const toolsFor = (serverId: string, generation: number) => {
    const tools = toolsByServer[serverId] ?? [];
    return (typeof tools === "function" ? tools(generation) : tools).map((name) => ({
      name,
      description: `${name} tool`,
      parametersSchema: { type: "object" },
    }));
  };

  function beginConnect(key: string): Attempt {
    const inFlight = connecting.get(key);
    if (inFlight) return inFlight;
    let resolve!: () => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const attempt: Attempt = { key, generation: generationOf(serverOf(key)), settled: false, promise, resolve, reject };
    attempts.push(attempt);
    started.push(key);
    connecting.set(key, attempt);
    promise.then(
      () => {
        attempt.settled = true;
        if (connecting.get(key) === attempt) connecting.delete(key);
        // Like the real manager, a process started with settings that have
        // been edited since is not kept as the live client.
        if (attempt.generation === generationOf(serverOf(key))) connected.set(key, attempt.generation);
      },
      () => {
        attempt.settled = true;
        if (connecting.get(key) === attempt) connecting.delete(key);
      },
    );
    if (state.autoLand) resolve();
    return attempt;
  }

  const manager: ExternalMcpServerManager = {
    getServer: async () => null,
    getServerByKey: async () => null,
    isReady: (serverId, companyId) => connected.has(`${serverId}::${companyId}`),
    configGeneration: (serverId) => generationOf(serverId),
    callTool: async () => ({ content: [], isError: false }),
    async evict(serverId, companyId) {
      if (companyId) {
        connected.delete(`${serverId}::${companyId}`);
        return;
      }
      generations.set(serverId, generationOf(serverId) + 1);
      for (const key of [...connected.keys()]) if (serverOf(key) === serverId) connected.delete(key);
      for (const key of [...connecting.keys()]) if (serverOf(key) === serverId) connecting.delete(key);
    },
    shutdown: async () => {},
    async listTools(serverId, companyId, listOptions) {
      const key = `${serverId}::${companyId}`;
      calls.push({ key, deadlineMs: listOptions?.deadlineMs });
      const live = connected.get(key);
      if (live !== undefined) return toolsFor(serverId, live);
      const attempt = beginConnect(key);
      // A cold Docker gateway always outlasts the discovery deadline.
      if (listOptions?.deadlineMs !== undefined) {
        throw new ExternalMcpWarmingError(serverId, listOptions.deadlineMs);
      }
      await attempt.promise;
      return toolsFor(serverId, attempt.generation);
    },
  };

  /** The newest connect for this key still starting, or the one started under `generation`. */
  function pending(key: string, generation?: number): Attempt | undefined {
    return attempts
      .filter((a) => a.key === key && !a.settled && (generation === undefined || a.generation === generation))
      .at(-1);
  }

  return {
    manager,
    calls,
    /** Connects begun, as `serverId::companyId`, in the order they began. */
    started,
    state,
    connectNow(key: string) {
      connected.set(key, generationOf(serverOf(key)));
    },
    land(key: string, generation?: number) {
      pending(key, generation)?.resolve();
    },
    fail(key: string, err: Error | string, generation?: number) {
      pending(key, generation)?.reject(typeof err === "string" ? new Error(err) : err);
    },
    /** What the manager does to a client after five idle minutes. */
    idleOut(key: string) {
      connected.delete(key);
    },
  };
}

/** Lets every pending promise callback run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function minutesPass(minutes: number): void {
  vi.setSystemTime(new Date(Date.now() + minutes * 60_000));
}

async function toolNames(source: ExternalMcpToolSource, companyId: string): Promise<string[]> {
  return (await source.listToolsForCompany(companyId)).map((t) => t.namespacedName).sort();
}

const key = (server: string, companyId: string) => `id-${server}::${companyId}`;

beforeEach(() => {
  // Only the clock: the tool cache and the idle gaps are measured with
  // Date.now(), and everything else should run for real.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T18:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("external MCP warm-up when Paperclip starts", () => {
  it("starts connecting while start-up carries on, with the full connect budget", async () => {
    const gateway = fakeManager({ "id-docker": ["get_me"], "id-home": ["get_state"] });
    const source = createExternalMcpToolSource(
      fakeDb([dockerGateway(), homeAssistant()]),
      gateway.manager,
    );

    const steps: string[] = [];
    const started = startPluginRuntime(true, {
      startJobCoordinator: () => steps.push("coordinator"),
      startScheduler: () => steps.push("scheduler"),
      loadPlugins: () => steps.push("load"),
      // The shape app.ts gives it: fire and forget.
      warmExternalMcpServers: () => {
        void source.warmUp();
        steps.push("warm");
      },
    });

    // Start-up has finished and no server has connected: it waited for none.
    expect(started).toBe(true);
    expect(steps).toEqual(["coordinator", "scheduler", "load", "warm"]);

    await settle();
    expect(gateway.started).toEqual([key("docker", HQ), key("home", BUREAU)]);
    // No discovery deadline: a cold gateway gets the whole connect budget.
    expect(gateway.calls.every((call) => call.deadlineMs === undefined)).toBe(true);
  });

  it("connects once for a server every company runs the same, and per named company for one with company secrets", async () => {
    const gateway = fakeManager({}, { autoLand: true });
    const source = createExternalMcpToolSource(
      fakeDb([
        // Same for everyone: one connect, as HQ, covers every company.
        dockerGateway(),
        // Same for everyone, named companies: one connect, as the first named.
        makeRow("notes", { allowedCompanies: [BUREAU, HQ] }),
        // Each company signs in with its own secret: one connect each.
        makeRow("home", { allowedCompanies: [BUREAU, HQ], envBindings: COMPANY_SECRET as never }),
        // Own secrets for every company would be a process per company: first use instead.
        makeRow("vault", { envBindings: COMPANY_SECRET as never }),
        // Nobody may use it.
        makeRow("off", { allowedCompanies: [] }),
      ]),
      gateway.manager,
    );

    await source.warmUp();

    expect([...gateway.started].sort()).toEqual(
      [key("docker", HQ), key("notes", BUREAU), key("home", BUREAU), key("home", HQ)].sort(),
    );
  });

  it("warms only active companies, so archived and paused ones get no process started with their secrets", async () => {
    const gateway = fakeManager({}, { autoLand: true });
    const source = createExternalMcpToolSource(
      fakeDb([
        makeRow("home", {
          allowedCompanies: [BUREAU, RETIRED, PAUSED],
          envBindings: COMPANY_SECRET as never,
        }),
        // The same for every company: warmed as the first active company named.
        makeRow("notes", { allowedCompanies: [RETIRED, PAUSED, BUREAU] }),
        // Named only by companies that are not active, or no longer exist.
        makeRow("retired", {
          allowedCompanies: [RETIRED, "99999999-9999-4999-8999-999999999999"],
          envBindings: COMPANY_SECRET as never,
        }),
      ]),
      gateway.manager,
    );

    await source.warmUp();

    expect([...gateway.started].sort()).toEqual([key("home", BUREAU), key("notes", BUREAU)].sort());
  });

  it("warms a portfolio-wide server as the oldest active company when there is no HQ", async () => {
    const gateway = fakeManager({}, { autoLand: true });
    const withoutHq = COMPANIES.map((row) => ({ ...row, isPortfolioRoot: false }));
    const source = createExternalMcpToolSource(fakeDb([dockerGateway()], withoutHq), gateway.manager);

    await source.warmUp();

    // RETIRED is older but archived.
    expect(gateway.started).toEqual([key("docker", BUREAU)]);
  });

  it("connects at most two servers at a time", async () => {
    const gateway = fakeManager({});
    const source = createExternalMcpToolSource(
      fakeDb(["a", "b", "c", "d"].map((name) => makeRow(name, { allowedCompanies: [BUREAU] }))),
      gateway.manager,
    );

    const warming = source.warmUp();
    await settle();
    expect(gateway.started).toEqual([key("a", BUREAU), key("b", BUREAU)]);

    gateway.land(key("a", BUREAU));
    await settle();
    expect(gateway.started).toHaveLength(3);

    gateway.land(key("b", BUREAU));
    await settle();
    gateway.land(key("c", BUREAU));
    gateway.land(key("d", BUREAU));
    await warming;
    expect(gateway.started).toHaveLength(4);
  });
});

describe("a server that cannot start does not stop Paperclip starting", () => {
  it("still warms the other servers, and resolves, when one fails to start", async () => {
    const gateway = fakeManager({ "id-docker": ["get_me"], "id-home": ["get_state"] });
    const source = createExternalMcpToolSource(
      fakeDb([dockerGateway(), homeAssistant()]),
      gateway.manager,
    );

    const warming = source.warmUp();
    await settle();
    gateway.fail(key("docker", HQ), "spawn docker ENOENT");
    gateway.land(key("home", BUREAU));
    await expect(warming).resolves.toBeUndefined();

    // The healthy server is connected for its company's first turn. The
    // broken one has no tools to show; it is tried again on use.
    expect(await toolNames(source, BUREAU)).toEqual(["mcp:home:get_state"]);
  });

  it("resolves when the server registry cannot be read, and start-up runs every step", async () => {
    const unreadable = {
      select: () => ({
        from: async () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:54329");
        },
      }),
    } as never;
    const source = createExternalMcpToolSource(unreadable, fakeManager({}).manager);

    let warming: Promise<void> | undefined;
    const steps: string[] = [];
    const started = startPluginRuntime(true, {
      startJobCoordinator: () => steps.push("coordinator"),
      startScheduler: () => steps.push("scheduler"),
      loadPlugins: () => steps.push("load"),
      warmExternalMcpServers: () => {
        warming = source.warmUp();
        steps.push("warm");
      },
    });

    expect(started).toBe(true);
    expect(steps).toEqual(["coordinator", "scheduler", "load", "warm"]);
    await expect(warming).resolves.toBeUndefined();
  });
});

describe("a warming server's tools do not vanish from a conversation", () => {
  it("keeps a server's tools while it reconnects after the idle timeout, without making the turn wait", async () => {
    const gateway = fakeManager({ "id-docker": ["get_me", "search_code"] });
    gateway.connectNow(key("docker", HQ));
    const source = createExternalMcpToolSource(fakeDb([dockerGateway()]), gateway.manager);

    const firstTurn = await toolNames(source, HQ);
    expect(firstTurn).toEqual(["mcp:docker:get_me", "mcp:docker:search_code"]);

    // Five quiet minutes close the client; the gateway takes most of a
    // minute to come back.
    gateway.idleOut(key("docker", HQ));
    minutesPass(6);
    const callsBefore = gateway.calls.length;

    // Returns while the reconnect is still pending, so the turn did not wait.
    expect(await toolNames(source, HQ)).toEqual(firstTurn);
    expect(gateway.started).toEqual([key("docker", HQ)]);
    expect(gateway.calls.slice(callsBefore).map((call) => call.deadlineMs)).toEqual([undefined]);

    // Once it is back, the next turn lists from the live client again.
    gateway.land(key("docker", HQ));
    await settle();
    minutesPass(1);
    expect(await toolNames(source, HQ)).toEqual(firstTurn);
    expect(gateway.manager.isReady("id-docker", HQ)).toBe(true);
  });

  it("keeps the tools warmed at start-up for the first turn after a restart, even once that client idled out", async () => {
    // The 2026-10-09 restart at 14:00: Clippy's next turn came at 14:08,
    // after the warmed client would already have idled out.
    const gateway = fakeManager({ "id-docker": ["get_me"] }, { autoLand: true });
    const source = createExternalMcpToolSource(fakeDb([dockerGateway()]), gateway.manager);
    await source.warmUp();

    gateway.idleOut(key("docker", HQ));
    gateway.state.autoLand = false;
    minutesPass(8);

    expect(await toolNames(source, HQ)).toEqual(["mcp:docker:get_me"]);
  });

  it("shows every company a server they all run the same while that company's own client starts", async () => {
    const gateway = fakeManager({ "id-docker": ["get_me"] }, { autoLand: true });
    const source = createExternalMcpToolSource(fakeDb([dockerGateway()]), gateway.manager);
    await source.warmUp();
    gateway.state.autoLand = false;

    expect(await toolNames(source, BUREAU)).toEqual(["mcp:docker:get_me"]);
    // Its own client is on the way, for when a tool is called.
    expect(gateway.started).toContain(key("docker", BUREAU));
  });

  it("does not show one company's tools to another when the server's secrets differ by company", async () => {
    const gateway = fakeManager({ "id-home": ["get_state"] });
    gateway.connectNow(key("home", BUREAU));
    const source = createExternalMcpToolSource(
      fakeDb([makeRow("home", { allowedCompanies: [BUREAU, HQ], envBindings: COMPANY_SECRET as never })]),
      gateway.manager,
    );

    expect(await toolNames(source, BUREAU)).toEqual(["mcp:home:get_state"]);
    // HQ signs in with its own secret, which may reach another account or
    // not start at all, so it waits for its own listing.
    expect(await toolNames(source, HQ)).toEqual([]);
  });

  it("does not share tools across companies when the secret is in a header", async () => {
    const gateway = fakeManager({ "id-crm": ["find_contact"] });
    gateway.connectNow(key("crm", BUREAU));
    const source = createExternalMcpToolSource(
      fakeDb([
        makeRow("crm", {
          transport: "http",
          url: "https://crm.example.test/mcp",
          allowedCompanies: [BUREAU, HQ],
          headerBindings: { Authorization: { type: "secret_ref", secretName: "CRM_TOKEN" } } as never,
        }),
      ]),
      gateway.manager,
    );

    expect(await toolNames(source, BUREAU)).toEqual(["mcp:crm:find_contact"]);
    expect(await toolNames(source, HQ)).toEqual([]);
  });

  it("drops a server's tools once it fails to reconnect, since none of them can run", async () => {
    const gateway = fakeManager({ "id-docker": ["get_me"] });
    gateway.connectNow(key("docker", HQ));
    const source = createExternalMcpToolSource(fakeDb([dockerGateway()]), gateway.manager);
    expect(await toolNames(source, HQ)).toEqual(["mcp:docker:get_me"]);

    gateway.idleOut(key("docker", HQ));
    minutesPass(6);
    expect(await toolNames(source, HQ)).toEqual(["mcp:docker:get_me"]);

    gateway.fail(key("docker", HQ), "Docker Desktop is not running");
    await settle();
    expect(await toolNames(source, HQ)).toEqual([]);

    // And it sits out the cool-off rather than being retried every turn.
    const callsBefore = gateway.calls.length;
    expect(await toolNames(source, HQ)).toEqual([]);
    expect(gateway.calls).toHaveLength(callsBefore);
  });

  it("does not keep tools from before an operator edited the server", async () => {
    const gateway = fakeManager({ "id-docker": ["get_me"] });
    gateway.connectNow(key("docker", HQ));
    const source = createExternalMcpToolSource(fakeDb([dockerGateway()]), gateway.manager);
    expect(await toolNames(source, HQ)).toEqual(["mcp:docker:get_me"]);

    // The edit evicts the client and may have changed the tool lists.
    await gateway.manager.evict("id-docker");

    expect(await toolNames(source, HQ)).toEqual([]);
  });

  it("keeps every other server's tools when one server is edited", async () => {
    const gateway = fakeManager({ "id-docker": ["get_me"], "id-notes": ["find_note"] });
    gateway.connectNow(key("docker", HQ));
    gateway.connectNow(key("notes", HQ));
    const source = createExternalMcpToolSource(fakeDb([dockerGateway(), makeRow("notes")]), gateway.manager);
    expect(await toolNames(source, HQ)).toEqual(["mcp:docker:get_me", "mcp:notes:find_note"]);

    gateway.idleOut(key("docker", HQ));
    await gateway.manager.evict("id-notes");
    minutesPass(6);

    // Docker is reconnecting and keeps its tools; only the edited server starts over.
    expect(await toolNames(source, HQ)).toEqual(["mcp:docker:get_me"]);
  });

  it("does not let a connect that lands after an edit replace the tools recorded since", async () => {
    // Before the edit the server offered one tool; after it, two.
    const gateway = fakeManager({
      "id-docker": (generation) => (generation === 0 ? ["get_me"] : ["get_me", "search_code"]),
    });
    gateway.connectNow(key("docker", HQ));
    const source = createExternalMcpToolSource(fakeDb([dockerGateway()]), gateway.manager);
    expect(await toolNames(source, HQ)).toEqual(["mcp:docker:get_me"]);

    // A reconnect starts with the old settings.
    gateway.idleOut(key("docker", HQ));
    minutesPass(6);
    expect(await toolNames(source, HQ)).toEqual(["mcp:docker:get_me"]);

    // The operator edits the server. The next turn connects with the new
    // settings, and that connect lands first.
    await gateway.manager.evict("id-docker");
    expect(await toolNames(source, HQ)).toEqual([]);
    gateway.land(key("docker", HQ), 1);
    await settle();

    // Then the old connect finishes, after the edit, with the old tools.
    gateway.land(key("docker", HQ), 0);
    await settle();

    gateway.idleOut(key("docker", HQ));
    minutesPass(6);
    expect(await toolNames(source, HQ)).toEqual(["mcp:docker:get_me", "mcp:docker:search_code"]);
  });

  it("does not cost a server its tools or a cool-off when a connect is closed because of an edit", async () => {
    const gateway = fakeManager({ "id-docker": ["get_me"] });
    gateway.connectNow(key("docker", HQ));
    const source = createExternalMcpToolSource(fakeDb([dockerGateway()]), gateway.manager);
    expect(await toolNames(source, HQ)).toEqual(["mcp:docker:get_me"]);
    gateway.idleOut(key("docker", HQ));
    minutesPass(6);
    expect(await toolNames(source, HQ)).toEqual(["mcp:docker:get_me"]);

    await gateway.manager.evict("id-docker");
    expect(await toolNames(source, HQ)).toEqual([]);
    gateway.land(key("docker", HQ), 1);
    await settle();

    // The manager closes the connect that started with the old settings.
    gateway.fail(key("docker", HQ), new ExternalMcpConfigChangedError("docker"), 0);
    await settle();

    gateway.idleOut(key("docker", HQ));
    minutesPass(6);
    expect(await toolNames(source, HQ)).toEqual(["mcp:docker:get_me"]);
  });

  it("keeps the tool list a resumed session reads from the MCP bridge the same from turn to turn", async () => {
    const gateway = fakeManager({ "id-docker": ["get_me", "search_code"] });
    gateway.connectNow(key("docker", HQ));
    const source = createExternalMcpToolSource(fakeDb([dockerGateway()]), gateway.manager);
    const dispatcher = createPluginToolDispatcher({
      externalMcpToolSource: source,
      externalMcpServerManager: gateway.manager,
    });
    const bridge = createPluginMcpBridge({ pluginToolDispatcher: dispatcher, db: {} as never });
    const token = bridge.mintToken({
      chatSessionId: "sess-pat",
      companyId: HQ,
      actor: { userId: "pat", isInstanceAdmin: true, companyIds: [HQ] },
    });
    const served = await serveBridge(bridge);

    try {
      // Each Clippy turn spawns a fresh Claude Code process that lists the
      // bridge's tools and compares them with what the session saw before.
      const firstTurn = await listBridgeTools(served.url(token));
      expect(firstTurn).toEqual(expect.arrayContaining(["mcp__docker:get_me", "mcp__docker:search_code"]));

      gateway.idleOut(key("docker", HQ));
      minutesPass(6);
      const nextTurn = await listBridgeTools(served.url(token));

      expect(nextTurn).toEqual(firstTurn);
    } finally {
      await served.close();
      bridge.revokeToken(token);
    }
  });
});

async function serveBridge(bridge: PluginMcpBridge) {
  const app = express();
  app.use(express.json());
  const handler = async (req: express.Request, res: express.Response) => {
    await bridge.handleHttpRequest(req.params.token as string, req, res, req.body);
  };
  app.post("/api/internal/mcp/:token", handler);
  app.get("/api/internal/mcp/:token", handler);
  app.delete("/api/internal/mcp/:token", handler);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    url: (token: string) => `http://127.0.0.1:${address.port}/api/internal/mcp/${token}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function listBridgeTools(url: string): Promise<string[]> {
  const client = new Client({ name: "resumed-session", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name).sort();
  } finally {
    await client.close();
  }
}
