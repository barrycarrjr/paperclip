import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  pluginConfig,
  pluginJobRuns,
  pluginJobs,
  pluginLogs,
  pluginWebhookDeliveries,
  plugins,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { pluginRoutes } from "../routes/plugins.js";
import { pluginJobStore } from "../services/plugin-job-store.js";
import { rememberPersonalCompany } from "../services/personal-companies.js";

/**
 * Plugins serve every company from one instance-wide config, and their logs and
 * run history carry a company id per row. These routes are read by anyone in a
 * company (connectors, config) or by instance admins (logs, runs, dashboard),
 * against the real routes and a real database, so each caller is shown only
 * the companies they may see, and nobody sees inside someone else's Personal.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plugin visibility tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const VIEWER = "viewer-user";
const ADMIN = "admin-user";
const BOB = "bob-user";
const OWNER = "owner-user";

describeEmbeddedPostgres("plugin routes show each caller only the companies they may see", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const pluginId = randomUUID();
  const jobId = randomUUID();
  let hqId: string;
  const workId = randomUUID();
  const printId = randomUUID();
  const bobPersonalId = randomUUID();
  const ownerPersonalId = randomUUID();
  let storedConfig: Record<string, unknown>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-visibility-");
    db = createDb(tempDb.connectionString);

    const company = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
      id,
      name,
      issuePrefix: `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      ...extra,
    });
    // There can be only one portfolio root; the migrations may have made it.
    const [existingRoot] = await db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.isPortfolioRoot, true));
    hqId = existingRoot?.id ?? randomUUID();
    if (!existingRoot) await db.insert(companies).values(company(hqId, "HQ", { isPortfolioRoot: true }));
    await db.insert(companies).values([
      company(workId, "Northwind Trading"),
      company(printId, "Print Shop"),
      company(bobPersonalId, "Personal", { kind: "personal", ownerUserId: BOB }),
      company(ownerPersonalId, "Personal", { kind: "personal", ownerUserId: OWNER }),
    ]);
    rememberPersonalCompany(bobPersonalId, BOB);
    rememberPersonalCompany(ownerPersonalId, OWNER);

    const companyIds = { type: "array", items: { type: "string", format: "company-id" } };
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.calendar-sync",
      packageName: "@paperclipai/plugin-calendar-sync",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "paperclip.calendar-sync",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Calendar Sync",
        description: "Test plugin",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: [],
        entrypoints: { worker: "./dist/worker.js" },
        instanceConfigSchema: {
          type: "object",
          properties: {
            pollMinutes: { type: "number" },
            alertCompanyId: { type: "string", format: "company-id" },
            accounts: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  key: { type: "string" },
                  userEmail: { type: "string" },
                  refreshTokenRef: { type: "string", format: "secret-ref" },
                  allowedCompanies: companyIds,
                },
              },
            },
          },
        },
        connectors: [
          {
            id: "calendar",
            surface: "calendar",
            displayName: "Calendar",
            connectionsKey: "accounts",
            companiesField: "allowedCompanies",
            labelField: "userEmail",
            requiredFields: ["refreshTokenRef"],
          },
        ],
      },
      status: "ready",
      installOrder: 1,
    });

    storedConfig = {
      pollMinutes: 5,
      alertCompanyId: bobPersonalId,
      accounts: [
        { key: "work", userEmail: "books@northwind.example", refreshTokenRef: "s1", allowedCompanies: [workId] },
        { key: "print", userEmail: "ops@print.example", refreshTokenRef: "s2", allowedCompanies: [printId] },
        { key: "bob", userEmail: "bob.private@example.com", refreshTokenRef: "s3", allowedCompanies: [bobPersonalId] },
        { key: "bob-new", userEmail: "bob.second@example.com", refreshTokenRef: "", allowedCompanies: [bobPersonalId] },
        {
          key: "owner",
          userEmail: "owner.private@example.com",
          refreshTokenRef: "s4",
          allowedCompanies: [ownerPersonalId],
        },
        {
          key: "everyone",
          userEmail: "shared@example.com",
          refreshTokenRef: "s5",
          allowedCompanies: ["*", bobPersonalId],
        },
      ],
    };
    await db.insert(pluginConfig).values({ pluginId, configJson: storedConfig, lastError: "bob.private@example.com: token expired" });

    const rowsFor = [
      { companyId: workId, label: "work" },
      { companyId: printId, label: "print" },
      { companyId: bobPersonalId, label: "bob" },
      { companyId: ownerPersonalId, label: "owner" },
      { companyId: null, label: "instance" },
    ];
    await db.insert(pluginLogs).values(
      rowsFor.map((row) => ({
        pluginId,
        companyId: row.companyId,
        level: "info",
        message: row.label === "bob" ? "Synced 'Divorce lawyer, 3pm' for Bob" : `log ${row.label}`,
        meta: { label: row.label },
      })),
    );
    await db.insert(pluginJobs).values({ id: jobId, pluginId, jobKey: "sync", schedule: "*/5 * * * *" });
    await db.insert(pluginJobRuns).values(
      rowsFor.map((row) => ({
        jobId,
        pluginId,
        companyId: row.companyId,
        trigger: "schedule" as const,
        status: "succeeded" as const,
        logs: [`run ${row.label}`],
      })),
    );
    await db.insert(pluginWebhookDeliveries).values(
      rowsFor.map((row) => ({
        pluginId,
        companyId: row.companyId,
        webhookKey: `hook-${row.label}`,
        status: "success" as const,
        payload: { label: row.label },
      })),
    );
  }, 90_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use(
      "/api",
      pluginRoutes(db, { installPlugin: vi.fn() } as never, {
        scheduler: {} as never,
        jobStore: pluginJobStore(db),
      }),
    );
    app.use(errorHandler);
    return app;
  }

  function signedIn(userId: string, companyIds: string[], extra: Record<string, unknown> = {}) {
    return {
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds,
      memberships: companyIds.map((companyId) => ({ companyId, membershipRole: "owner", status: "active" })),
      ...extra,
    };
  }

  /** A viewer in one company. */
  const viewer = () =>
    signedIn(VIEWER, [workId], { memberships: [{ companyId: workId, membershipRole: "viewer", status: "active" }] });
  /** An instance admin who is a member of one company and is not in HQ. */
  const admin = () => signedIn(ADMIN, [workId], { isInstanceAdmin: true });
  /** The owner: an instance admin, the HQ owner, and the owner of his own Personal. */
  const owner = () =>
    signedIn(OWNER, [hqId, workId, ownerPersonalId], { isInstanceAdmin: true, isPortfolioRootUserAdmin: true });

  async function connectorCompanies(actor: Record<string, unknown>) {
    const res = await request(createApp(actor)).get("/api/plugins/connectors?surface=calendar");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(1);
    return res.body[0] as {
      companies: Array<{ companyId: string; accountLabel: string | null }>;
      unfinishedAccounts: string[];
    };
  }

  async function logLabels(actor: Record<string, unknown>) {
    const res = await request(createApp(actor)).get(`/api/plugins/${pluginId}/logs?limit=500`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body as Array<{ meta: { label: string } }>).map((row) => row.meta.label).sort();
  }

  async function runLabels(actor: Record<string, unknown>) {
    const res = await request(createApp(actor)).get(`/api/plugins/${pluginId}/jobs/${jobId}/runs?limit=500`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body as Array<{ logs: string[] }>).map((run) => run.logs[0]!.replace("run ", "")).sort();
  }

  async function dashboardLabels(actor: Record<string, unknown>) {
    const res = await request(createApp(actor)).get(`/api/plugins/${pluginId}/dashboard`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const runs = await db.select({ id: pluginJobRuns.id, logs: pluginJobRuns.logs }).from(pluginJobRuns);
    const runLabel = new Map(runs.map((run) => [run.id, run.logs[0]!.replace("run ", "")]));
    return {
      runs: (res.body.recentJobRuns as Array<{ id: string }>).map((run) => runLabel.get(run.id)).sort(),
      deliveries: (res.body.recentWebhookDeliveries as Array<{ webhookKey: string }>)
        .map((delivery) => delivery.webhookKey.replace("hook-", ""))
        .sort(),
    };
  }

  it("shows a viewer only her own company's connector, and none of Bob's accounts", async () => {
    const connector = await connectorCompanies(viewer());

    expect(connector.companies.map((row) => row.companyId)).toEqual([workId]);
    expect(connector.companies[0]!.accountLabel).toBe("books@northwind.example");
    expect(connector.unfinishedAccounts).toEqual([]);
    expect(JSON.stringify(connector)).not.toContain("bob.");
  });

  it("gives a viewer only the parts of the config that serve her company", async () => {
    const res = await request(createApp(viewer())).get(`/api/plugins/${pluginId}/config`);

    expect(res.status).toBe(200);
    expect(res.body.configJson).toEqual({
      pollMinutes: 5,
      accounts: [
        { key: "work", userEmail: "books@northwind.example", refreshTokenRef: "s1", allowedCompanies: [workId] },
        { key: "everyone", userEmail: "shared@example.com", refreshTokenRef: "s5", allowedCompanies: ["*"] },
      ],
    });
    expect(res.body.lastError).toBeNull();
    const text = JSON.stringify(res.body);
    for (const hidden of [printId, bobPersonalId, ownerPersonalId, "bob.private", "ops@print"]) {
      expect(text).not.toContain(hidden);
    }
  });

  it("keeps the logs, job runs and dashboard from anyone but an instance admin", async () => {
    const app = createApp(viewer());

    expect((await request(app).get(`/api/plugins/${pluginId}/logs`)).status).toBe(403);
    expect((await request(app).get(`/api/plugins/${pluginId}/jobs/${jobId}/runs`)).status).toBe(403);
    expect((await request(app).get(`/api/plugins/${pluginId}/dashboard`)).status).toBe(403);
  });

  it("shows an instance admin every company's connector but other people's Personal", async () => {
    const connector = await connectorCompanies(admin());
    expect(connector.companies.map((row) => row.companyId).sort()).toEqual([printId, workId].sort());
    expect(connector.unfinishedAccounts).toEqual([]);
  });

  it("leaves other people's Personal out of an instance admin's logs", async () => {
    expect(await logLabels(admin())).toEqual(["instance", "print", "work"]);
  });

  it("leaves other people's Personal out of an instance admin's job runs", async () => {
    expect(await runLabels(admin())).toEqual(["instance", "print", "work"]);
  });

  it("leaves other people's Personal out of an instance admin's dashboard", async () => {
    expect(await dashboardLabels(admin())).toEqual({
      runs: ["instance", "print", "work"],
      deliveries: ["instance", "print", "work"],
    });
  });

  it("gives an instance admin the whole config, because the settings page saves it back", async () => {
    const res = await request(createApp(admin())).get(`/api/plugins/${pluginId}/config`);

    expect(res.status).toBe(200);
    expect(res.body.configJson).toEqual(storedConfig);
  });

  it("leaves the owner everything he had, except inside someone else's Personal", async () => {
    const connector = await connectorCompanies(owner());
    expect(connector.companies.map((row) => row.companyId).sort()).toEqual(
      [ownerPersonalId, printId, workId].sort(),
    );
    expect(connector.companies.find((row) => row.companyId === ownerPersonalId)!.accountLabel).toBe(
      "owner.private@example.com",
    );

    const configRes = await request(createApp(owner())).get(`/api/plugins/${pluginId}/config`);
    expect(configRes.status).toBe(200);
    expect(configRes.body.configJson).toEqual(storedConfig);
    expect(configRes.body.lastError).toBe("bob.private@example.com: token expired");

    expect(await logLabels(owner())).toEqual(["instance", "owner", "print", "work"]);
    expect(await runLabels(owner())).toEqual(["instance", "owner", "print", "work"]);
    expect(await dashboardLabels(owner())).toEqual({
      runs: ["instance", "owner", "print", "work"],
      deliveries: ["instance", "owner", "print", "work"],
    });
  });
});
