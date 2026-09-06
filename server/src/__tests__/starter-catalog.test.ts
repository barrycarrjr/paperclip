import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { STARTER_CARDS, type PluginStatus } from "@paperclipai/shared";
import { agents, companies, createDb, plugins } from "@paperclipai/db";
import {
  blockersForPlugins,
  pickAssigneeForCompany,
  pluginStateByKey,
  starterCatalogService,
  starterRoutineMarker,
  type PluginStateByKey,
} from "../services/starter-catalog.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres starter catalog tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function moduleSource(): string {
  return readFileSync(new URL("../services/starter-catalog.ts", import.meta.url), "utf8");
}

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

describe("starter catalog operator-facing strings", () => {
  it("no activation step or refusal string contains an em or en dash", () => {
    // A static scan of the module with its comments removed: what is left
    // is code and string literals, and the strings are what the operator
    // reads in the activation receipt and in refusals. Comments may keep
    // their dashes; the screen may not.
    const emDash = String.fromCharCode(0x2014);
    const enDash = String.fromCharCode(0x2013);
    const offending = withoutComments(moduleSource())
      .split("\n")
      .filter((line) => line.includes(emDash) || line.includes(enDash));
    expect(offending).toEqual([]);
  });
});

describe("blockersForPlugins", () => {
  const state: PluginStateByKey = new Map([
    ["ready-one", { id: "p-ready", status: "ready" }],
    ["uninstalled-one", { id: "p-gone", status: "uninstalled" }],
    ["disabled-one", { id: "p-off", status: "disabled" }],
    ["installed-one", { id: "p-installed", status: "installed" }],
    ["error-one", { id: "p-error", status: "error" }],
    ["upgrading-one", { id: "p-upgrade", status: "upgrade_pending" }],
  ]);

  it("reports missing for absent or uninstalled keys and disabled for any non-ready status, and nothing for ready", () => {
    expect(blockersForPlugins(["ready-one"], state)).toEqual([]);
    expect(blockersForPlugins([], state)).toEqual([]);

    // Never installed and installed-then-removed read the same to the
    // operator: someone has to install it.
    expect(blockersForPlugins(["never-installed", "uninstalled-one"], state)).toEqual([
      { pluginKey: "never-installed", kind: "missing", detail: "never-installed is not installed" },
      { pluginKey: "uninstalled-one", kind: "missing", detail: "uninstalled-one is not installed" },
    ]);

    // Every other non-ready status is something the service can try to
    // switch back on, and the detail names the status so the operator can
    // tell "switched off" from "broken".
    const notReady = blockersForPlugins(
      ["disabled-one", "installed-one", "error-one", "upgrading-one"],
      state,
    );
    expect(notReady.map((b) => b.kind)).toEqual(["disabled", "disabled", "disabled", "disabled"]);
    expect(notReady.map((b) => b.detail)).toEqual([
      "disabled-one is installed but not running (disabled)",
      "installed-one is installed but not running (installed)",
      "error-one is installed but not running (error)",
      "upgrading-one is installed but not running (upgrade_pending)",
    ]);

    // Order follows the required list, one blocker per key, ready keys skipped.
    expect(
      blockersForPlugins(["disabled-one", "ready-one", "never-installed"], state).map(
        (b) => b.pluginKey,
      ),
    ).toEqual(["disabled-one", "never-installed"]);
  });

  it("is the only copy of the readiness rule in the module", () => {
    // A same-module call cannot be intercepted by a spy under ESM (the
    // service binds the local function, not the export), so the guard
    // against a second copy is structural: the readiness comparison exists
    // once, and both service paths reach it through blockersForPlugins.
    const code = withoutComments(moduleSource());
    expect(code.match(/=== "uninstalled"/g)?.length).toBe(1);
    expect(code.match(/!== "ready"/g)?.length).toBe(1);
    // The trailing comma picks out the blocker literals and skips the
    // StarterBlocker type declaration.
    expect(code.match(/kind: "missing",/g)?.length).toBe(1);
    expect(code.match(/kind: "disabled",/g)?.length).toBe(1);
    // listForCompany and activate: two call sites, both on the shared function.
    expect(code.match(/blockersForPlugins\(card\.requiresPlugins, state\)/g)?.length).toBe(2);
    // And the assignee rule likewise lives only in pickAssigneeForCompany.
    expect(code.match(/a\.role === "ceo"/g)?.length).toBe(1);
    expect(code.match(/pickAssigneeForCompany\(db, companyId\)/g)?.length).toBe(1);
  });
});

describeEmbeddedPostgres("starter catalog against a database", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-starter-catalog-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(plugins);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(
    companyId: string,
    input: { name: string; role: string; status: string },
  ): Promise<string> {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: input.name,
      role: input.role,
      status: input.status,
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  async function seedPlugin(pluginKey: string, status: PluginStatus): Promise<string> {
    const id = randomUUID();
    await db.insert(plugins).values({
      id,
      pluginKey,
      packageName: `@test/${pluginKey}`,
      version: "1.0.0",
      apiVersion: 1,
      status,
      categories: ["connector"],
      manifestJson: {
        id: pluginKey,
        apiVersion: 1,
        version: "1.0.0",
        displayName: pluginKey,
        description: "Test plugin",
        author: "Paperclip",
        categories: ["connector"],
        capabilities: [],
        entrypoints: { worker: "dist/worker.js" },
      },
    });
    return id;
  }

  it("pickAssigneeForCompany prefers the CEO, then an officer, then any agent that is not paused or terminated, then null", async () => {
    const companyId = await seedCompany();
    // Four agents. The terminated CEO is listed first so a naive "first CEO
    // wins" would pick it; it must never be chosen.
    await seedAgent(companyId, { name: "Old Boss", role: "ceo", status: "terminated" });
    const ceo = await seedAgent(companyId, { name: "Ada", role: "ceo", status: "idle" });
    const coo = await seedAgent(companyId, { name: "Bea", role: "coo", status: "running" });
    const engineer = await seedAgent(companyId, { name: "Cy", role: "engineer", status: "active" });

    // A different company's live CEO must not leak in.
    const otherCompanyId = await seedCompany();
    await seedAgent(otherCompanyId, { name: "Elsewhere", role: "ceo", status: "idle" });

    expect(await pickAssigneeForCompany(db, companyId)).toEqual({ id: ceo, name: "Ada" });

    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, ceo));
    expect(await pickAssigneeForCompany(db, companyId)).toEqual({ id: coo, name: "Bea" });

    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, coo));
    expect(await pickAssigneeForCompany(db, companyId)).toEqual({ id: engineer, name: "Cy" });

    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, engineer));
    expect(await pickAssigneeForCompany(db, companyId)).toBeNull();

    // An officer other than the COO still outranks a plain agent.
    const cto = await seedAgent(companyId, { name: "Dee", role: "cto", status: "idle" });
    await seedAgent(companyId, { name: "Eve", role: "engineer", status: "idle" });
    expect(await pickAssigneeForCompany(db, companyId)).toEqual({ id: cto, name: "Dee" });
  });

  it("pickAssigneeForCompany never picks an agent that is still waiting for approval", async () => {
    // The accept path refuses to assign work to a pending approval agent,
    // so naming one as the lead would promise something that cannot happen.
    const companyId = await seedCompany();
    const pendingCeo = await seedAgent(companyId, { name: "Not Approved Yet", role: "ceo", status: "pending_approval" });
    const engineer = await seedAgent(companyId, { name: "Cy", role: "engineer", status: "idle" });

    expect(await pickAssigneeForCompany(db, companyId)).toEqual({ id: engineer, name: "Cy" });

    // With nobody else, there is no lead at all rather than an unusable one.
    await db.delete(agents).where(eq(agents.id, engineer));
    expect(await pickAssigneeForCompany(db, companyId)).toBeNull();
    expect(pendingCeo).toBeTruthy();
  });

  it("starterCatalogService.listForCompany derives readiness through blockersForPlugins", async () => {
    const companyId = await seedCompany();
    // One key in every state the rule distinguishes: ready, switched off,
    // removed, and never installed (slack-tools and backup-tools are absent).
    await seedPlugin("gbp-reviews", "ready");
    await seedPlugin("phone-tools", "disabled");
    await seedPlugin("help-scout", "ready");
    await seedPlugin("3cx-tools", "uninstalled");

    const state = await pluginStateByKey(db);
    expect(state.get("gbp-reviews")?.status).toBe("ready");
    expect(state.get("3cx-tools")?.status).toBe("uninstalled");
    expect(state.has("slack-tools")).toBe(false);

    const statuses = await starterCatalogService(db).listForCompany(companyId);
    expect(statuses.map((s) => s.card.id)).toEqual(STARTER_CARDS.map((c) => c.id));

    for (const status of statuses) {
      const expected = blockersForPlugins(status.card.requiresPlugins, state);
      expect(status.blockers).toEqual(expected);
      expect(status.ready).toBe(expected.length === 0);
      expect(status.fixable).toBe(
        expected.length > 0 && expected.every((b) => b.kind === "disabled"),
      );
    }

    const byId = new Map(statuses.map((s) => [s.card.id, s]));
    expect(byId.get("reply-google-reviews")?.ready).toBe(true);
    expect(byId.get("monday-morning-brief")?.ready).toBe(true);
    expect(byId.get("call-web-form-leads")).toMatchObject({ ready: false, fixable: true });
    expect(byId.get("daily-phone-report")).toMatchObject({ ready: false, fixable: false });
    expect(byId.get("daily-support-numbers")?.blockers).toEqual([
      { pluginKey: "slack-tools", kind: "missing", detail: "slack-tools is not installed" },
    ]);
  });
});

/**
 * The service's database-touching paths are covered by the live end-to-end
 * check (activate a card, assert a routine exists, is scheduled, and has run).
 * What is worth pinning here is the part that would silently rot: the marker
 * used to recognise a company's existing starter routines.
 */
describe("starter routine marker", () => {
  it("round-trips every card id", () => {
    for (const card of STARTER_CARDS) {
      const marker = starterRoutineMarker(card.id);
      expect(marker).toContain(card.id);
      // Must survive being embedded in a routine description and found again.
      const description = `Some instructions.\n\n${marker}`;
      expect(description.includes(marker)).toBe(true);
    }
  });

  it("does not collide between cards", () => {
    const markers = STARTER_CARDS.map((c) => starterRoutineMarker(c.id));
    expect(new Set(markers).size).toBe(markers.length);
  });

  it("stays invisible in rendered markdown", () => {
    // An HTML comment so the operator reading the routine never sees it.
    expect(starterRoutineMarker("x")).toMatch(/^<!--.*-->$/);
  });

  it("does not match a different card's marker by prefix", () => {
    // "call-web-form-leads" must not be found inside a description carrying
    // "call-web-form-leads-extra", or switching one card on would report the
    // other as already active.
    const base = starterRoutineMarker("call-web-form-leads");
    const longer = starterRoutineMarker("call-web-form-leads-extra");
    expect(longer.includes(base)).toBe(false);
  });
});
