/**
 * Integration test for the external-MCP connector.
 *
 * Boots an embedded Postgres, inserts a real `external_mcp_servers` row that
 * spawns `server/src/__tests__/fixtures/mock-mcp-server.mjs` over stdio
 * (via `node <abs-path>`, no npx / .cmd resolution issues on Windows), then
 * exercises the manager + tool source against it. Asserts:
 *
 *   1. happy path: connect → listTools → callTool ("echo") works
 *   2. tool name namespacing flows through the tool source
 *   3. mutation gate: `create_thing` is rejected when allowMutations=false,
 *      and accepted when added to writeAllowList
 *   4. company isolation: a company not in allowedCompanies is denied at
 *      the listTools layer
 *   5. secret-ref env injection: a binding to a company secret named
 *      `SECRET_TOKEN` resolves to the secret's value inside the spawned
 *      child (verified by the fixture's `read_secret_env` tool).
 *
 * Replaces the deferred-from-the-plan integration test that originally
 * needed `npx -y @modelcontextprotocol/server-filesystem`.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, externalMcpServers } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createExternalMcpServerManager } from "../services/external-mcp-server-manager.js";
import { createExternalMcpToolSource } from "../services/external-mcp-tool-source.js";
import { secretService } from "../services/secrets.js";

const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/mock-mcp-server.mjs", import.meta.url),
);

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping external-MCP integration test on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("external MCP connector — integration", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let manager!: ReturnType<typeof createExternalMcpServerManager>;
  let toolSource!: ReturnType<typeof createExternalMcpToolSource>;
  let companyA!: string;
  let companyB!: string;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("external-mcp-int");
    stopDb = started.stop;
    db = createDb(started.connectionString);

    companyA = randomUUID();
    companyB = randomUUID();
    // issuePrefix is a unique index — each test company needs its own.
    await db.insert(companies).values([
      {
        id: companyA,
        name: "Company A (allowed)",
        status: "active",
        issuePrefix: "MCPA",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: companyB,
        name: "Company B (not allowed)",
        status: "active",
        issuePrefix: "MCPB",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    // Tighter idle timeout so multiple tests don't share a stale stdio child
    // longer than necessary.
    manager = createExternalMcpServerManager(db, { idleTimeoutMs: 5_000 });
    toolSource = createExternalMcpToolSource(db, manager);
  }, 60_000);

  afterAll(async () => {
    if (manager) await manager.shutdown();
    if (stopDb) await stopDb();
  });

  async function insertServer(opts: {
    key: string;
    allowedCompanies: string[];
    allowMutations?: boolean;
    writeAllowList?: string[];
    envBindings?: Record<string, unknown>;
  }) {
    const id = randomUUID();
    await db.insert(externalMcpServers).values({
      id,
      key: opts.key,
      displayName: opts.key,
      transport: "stdio",
      // Use the current Node binary explicitly — guaranteed on PATH and a
      // real .exe on Windows (no .cmd shenanigans).
      command: process.execPath,
      args: [FIXTURE_PATH],
      envBindings: (opts.envBindings ?? {}) as never,
      headerBindings: {},
      allowedCompanies: opts.allowedCompanies,
      allowMutations: opts.allowMutations ?? false,
      writeAllowList: opts.writeAllowList ?? [],
      toolAllowList: [],
      toolDenyList: [],
    });
    return id;
  }

  // -----------------------------------------------------------------------
  // 1. Happy path — discover + call a read tool
  // -----------------------------------------------------------------------
  it("lists tools and calls a read tool end-to-end", async () => {
    const id = await insertServer({
      key: `mock-${randomUUID().slice(0, 8)}`,
      allowedCompanies: [companyA],
    });

    const tools = await manager.listTools(id, companyA);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["create_thing", "echo", "read_secret_env"]);

    const result = await manager.callTool(id, companyA, "echo", {
      message: "hello from test",
    });
    expect(result.isError).toBe(false);
    const flat = JSON.stringify(result.content);
    expect(flat).toContain("echo: hello from test");
  }, 30_000);

  // -----------------------------------------------------------------------
  // 2. Namespacing flows through the tool source
  // -----------------------------------------------------------------------
  it("namespaces tools as mcp:<key>:<tool> when listed for a company", async () => {
    const key = `ns-${randomUUID().slice(0, 8)}`;
    await insertServer({ key, allowedCompanies: [companyA] });

    const aggregated = await toolSource.listToolsForCompany(companyA);
    const fromUs = aggregated.filter((t) => t.serverKey === key);
    const namespaced = fromUs.map((t) => t.namespacedName).sort();
    expect(namespaced).toEqual([
      `mcp:${key}:create_thing`,
      `mcp:${key}:echo`,
      `mcp:${key}:read_secret_env`,
    ]);
  }, 30_000);

  // -----------------------------------------------------------------------
  // 3. Mutation gate — heuristic-detected mutation is denied unless
  //    explicitly allow-listed (or allowMutations master switch is on).
  // -----------------------------------------------------------------------
  it("rejects a mutation tool by default and accepts it when in writeAllowList", async () => {
    const denyId = await insertServer({
      key: `gate-${randomUUID().slice(0, 8)}`,
      allowedCompanies: [companyA],
      allowMutations: false,
    });
    await expect(
      manager.callTool(denyId, companyA, "create_thing", { name: "x" }),
    ).rejects.toThrow(/EDISABLED/);

    const allowId = await insertServer({
      key: `gate-${randomUUID().slice(0, 8)}`,
      allowedCompanies: [companyA],
      allowMutations: false,
      writeAllowList: ["create_thing"],
    });
    const result = await manager.callTool(allowId, companyA, "create_thing", {
      name: "x",
    });
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.content)).toContain("created: x");
  }, 60_000);

  // -----------------------------------------------------------------------
  // 4. Company isolation — companyB is not in allowedCompanies, so the
  //    server doesn't appear when listing for B, and a direct call attempt
  //    via the secret resolver is rejected with the structured error.
  // -----------------------------------------------------------------------
  it("hides the server from companies not in allowedCompanies", async () => {
    const key = `iso-${randomUUID().slice(0, 8)}`;
    await insertServer({ key, allowedCompanies: [companyA] });

    const forA = (await toolSource.listToolsForCompany(companyA)).filter(
      (t) => t.serverKey === key,
    );
    const forB = (await toolSource.listToolsForCompany(companyB)).filter(
      (t) => t.serverKey === key,
    );

    expect(forA.length).toBeGreaterThan(0);
    expect(forB.length).toBe(0);
  }, 30_000);

  // -----------------------------------------------------------------------
  // 5. Secret-ref env binding — value resolves inside the spawned child.
  // -----------------------------------------------------------------------
  it("injects a secret-ref env binding into the spawned child", async () => {
    // Create a real company secret. The binding refers to it by name so
    // each company resolves against its own vault — same pattern the
    // existing project / agent env editor uses.
    const svc = secretService(db);
    await svc.create(companyA, {
      name: "SECRET_TOKEN",
      provider: "local_encrypted",
      value: "shh-this-is-the-test-value",
      description: null,
    });

    const id = await insertServer({
      key: `secret-${randomUUID().slice(0, 8)}`,
      allowedCompanies: [companyA],
      envBindings: {
        SECRET_TOKEN: {
          type: "secret_ref",
          secretName: "SECRET_TOKEN",
        },
      },
    });

    const result = await manager.callTool(id, companyA, "read_secret_env", {});
    expect(result.isError).toBe(false);
    const flat = JSON.stringify(result.content);
    expect(flat).toContain("SECRET_TOKEN=shh-this-is-the-test-value");
  }, 30_000);

  // -----------------------------------------------------------------------
  // 6. Slow cold start: a server that takes longer to boot than the
  //    discovery deadline must not hold up the turn, and must join in on
  //    its own once it finishes connecting.
  // -----------------------------------------------------------------------
  it("skips a slow-starting server, then picks it up once it is warm", async () => {
    const key = `slow-${randomUUID().slice(0, 8)}`;
    const id = await insertServer({
      key,
      allowedCompanies: [companyA],
      // Longer than DISCOVERY_DEADLINE_MS (5s) in the tool source.
      envBindings: { MOCK_MCP_STARTUP_DELAY_MS: { type: "plain", value: "8000" } },
    });

    const startedAt = Date.now();
    const firstPass = await toolSource.listToolsForCompany(companyA);
    const firstPassMs = Date.now() - startedAt;

    // The turn went ahead without it. This is the whole point.
    expect(firstPass.filter((t) => t.serverKey === key)).toHaveLength(0);
    expect(firstPassMs).toBeLessThan(7_000);

    // Meanwhile the connect kept running in the background. Wait for it.
    const readyBy = Date.now() + 20_000;
    while (!manager.isReady(id, companyA) && Date.now() < readyBy) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(manager.isReady(id, companyA)).toBe(true);

    // Readiness beats the failure cool-off, so the tools show up on the very
    // next turn rather than after a further minute of being skipped.
    const secondPass = await toolSource.listToolsForCompany(companyA);
    const names = secondPass
      .filter((t) => t.serverKey === key)
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(["create_thing", "echo", "read_secret_env"]);
  }, 60_000);

  // -----------------------------------------------------------------------
  // 7. Concurrent callers share one cold start rather than each spawning
  //    their own child.
  // -----------------------------------------------------------------------
  it("spawns a single child when several callers arrive during one connect", async () => {
    const spawnLog = path.join(
      os.tmpdir(),
      `mcp-spawns-${randomUUID().slice(0, 8)}.log`,
    );
    const id = await insertServer({
      key: `dedupe-${randomUUID().slice(0, 8)}`,
      allowedCompanies: [companyA],
      envBindings: {
        MOCK_MCP_SPAWN_LOG: { type: "plain", value: spawnLog },
        MOCK_MCP_STARTUP_DELAY_MS: { type: "plain", value: "1500" },
      },
    });

    const results = await Promise.all([
      manager.listTools(id, companyA),
      manager.listTools(id, companyA),
      manager.listTools(id, companyA),
      manager.listTools(id, companyA),
    ]);
    for (const tools of results) {
      expect(tools.map((t) => t.name).sort()).toEqual([
        "create_thing",
        "echo",
        "read_secret_env",
      ]);
    }

    const spawns = readFileSync(spawnLog, "utf8").trim().split("\n").filter(Boolean);
    expect(spawns).toHaveLength(1);
    rmSync(spawnLog, { force: true });
  }, 60_000);

  // -----------------------------------------------------------------------
  // 8. The connect budget actually governs the handshake.
  //
  //    Regression: `client.connect()` was called without a timeout, so the
  //    SDK applied its own 60s `DEFAULT_REQUEST_TIMEOUT_MSEC` to `initialize`
  //    and CONNECT_TIMEOUT_MS was never reached. Any server slower than 60s
  //    to boot (Docker MCP Gateway among them) could never connect at all,
  //    no matter how the budget was configured.
  // -----------------------------------------------------------------------
  it("honours the configured connect budget in both directions", async () => {
    const generousManager = createExternalMcpServerManager(db, {
      idleTimeoutMs: 5_000,
      connectTimeoutMs: 15_000,
    });
    const stingyManager = createExternalMcpServerManager(db, {
      idleTimeoutMs: 5_000,
      connectTimeoutMs: 1_000,
    });

    const id = await insertServer({
      key: `budget-${randomUUID().slice(0, 8)}`,
      allowedCompanies: [companyA],
      envBindings: { MOCK_MCP_STARTUP_DELAY_MS: { type: "plain", value: "4000" } },
    });

    try {
      // 4s boot inside a 15s budget: connects. Before the fix this proved
      // nothing, because the SDK's own default governed instead.
      const tools = await generousManager.listTools(id, companyA);
      expect(tools.map((t) => t.name).sort()).toContain("echo");

      // 4s boot against a 1s budget: gives up, and says so.
      await expect(stingyManager.listTools(id, companyA)).rejects.toThrow(
        /timed out/i,
      );
    } finally {
      await generousManager.shutdown();
      await stingyManager.shutdown();
    }
  }, 60_000);
});
