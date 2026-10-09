import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import express from "express";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issueReferenceMentions,
  issues,
} from "@paperclipai/db";
import { AGENT_FINDING_ORIGIN_KIND } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent-finding tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * A reporter that sees the same finding on every sweep files it once.
 *
 * Before the finding key existed, the dedupe fields an agent sent were dropped
 * by the create contract, so every sweep filed the warning again: one company
 * collected 82 open issues from a single agent, almost all repeats.
 */
describeEmbeddedPostgres("creating an issue with an agent finding key", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
  let companyIds: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-agent-finding-");
    db = createDb(tempDb.connectionString);

    const [{ errorHandler }, { issueRoutes }] = await Promise.all([
      import("../middleware/index.js"),
      import("../routes/issues.js"),
    ]);

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        // Lets a test act as a second reporter.
        userId: req.header("x-test-user") ?? "board-user",
        companyIds,
        source: "session",
        isInstanceAdmin: true,
      };
      next();
    });
    app.use(issueRoutes(db, {} as any, {}));
    app.use(errorHandler);
  }, 90_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueReferenceMentions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    companyIds = [];
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: "Acme",
      issuePrefix: `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    companyIds.push(id);
    return id;
  }

  function report(
    companyId: string,
    key: string,
    opts: { title?: string; as?: string } = {},
  ) {
    return request(app)
      .post(`/companies/${companyId}/issues`)
      .set("x-test-user", opts.as ?? "board-user")
      .send({
        title: opts.title ?? "Steward proposal: secret-scan: key in config",
        origin: { kind: AGENT_FINDING_ORIGIN_KIND, id: key },
      });
  }

  it("keeps the key on the issue, so the finding can be found again", async () => {
    const companyId = await seedCompany();

    const res = await report(companyId, "secret:abc123");

    expect(res.status).toBe(201);
    const [row] = await db.select().from(issues).where(eq(issues.id, res.body.id));
    expect(row.originKind).toBe(AGENT_FINDING_ORIGIN_KIND);
    expect(row.originId).toBe("secret:abc123");

    const listed = await request(app)
      .get(`/companies/${companyId}/issues`)
      .query({ originKind: AGENT_FINDING_ORIGIN_KIND, originId: "secret:abc123" });
    expect(listed.status).toBe(200);
    expect(listed.body.map((issue: { id: string }) => issue.id)).toEqual([res.body.id]);
  });

  it("refuses the same finding again and names the issue that has it", async () => {
    const companyId = await seedCompany();
    const first = await report(companyId, "agent-error:eb7fabd63c2be400");
    expect(first.status).toBe(201);

    const again = await report(companyId, "agent-error:eb7fabd63c2be400", { title: "Reworded by the next sweep" });

    expect(again.status).toBe(409);
    expect(again.body.code).toBe("agent_finding_already_reported");
    expect(again.body.error).toContain(first.body.identifier);
    expect(again.body.details.existingIssue.id).toBe(first.body.id);
    expect(await db.select().from(issues)).toHaveLength(1);
  });

  it("still refuses it after the first one was cancelled", async () => {
    const companyId = await seedCompany();
    const first = await report(companyId, "secret:denied");
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, first.body.id));

    const again = await report(companyId, "secret:denied");

    expect(again.status).toBe(409);
    expect(again.body.error).toContain("cancelled");
  });

  it("still refuses it after the first one was hidden, which is how a person dismisses it", async () => {
    const companyId = await seedCompany();
    const first = await report(companyId, "secret:hidden");
    await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, first.body.id));

    expect((await report(companyId, "secret:hidden")).status).toBe(409);
  });

  it("files a different key, and the same key in another company", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    expect((await report(companyId, "secret:one")).status).toBe(201);

    expect((await report(companyId, "secret:two")).status).toBe(201);
    expect((await report(otherCompanyId, "secret:one")).status).toBe(201);
  });

  it("belongs to its reporter, so nobody else can silence a finding by filing its key first", async () => {
    const companyId = await seedCompany();
    const squatter = await report(companyId, "secret:shared", { as: "someone-else" });
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, squatter.body.id));

    expect((await report(companyId, "secret:shared")).status).toBe(201);
    expect((await report(companyId, "secret:shared")).status).toBe(409);
  });

  it("files only once when two reports of the same finding arrive together", async () => {
    const companyId = await seedCompany();

    const results = await Promise.all([report(companyId, "secret:race"), report(companyId, "secret:race")]);

    expect(results.map((res) => res.status).sort()).toEqual([201, 409]);
    expect(await db.select().from(issues)).toHaveLength(1);
  });

  it("keeps the key on a child issue and refuses a repeat there too", async () => {
    const companyId = await seedCompany();
    const digest = await request(app).post(`/companies/${companyId}/issues`).send({ title: "Steward digest" });
    expect(digest.status).toBe(201);
    const child = () =>
      request(app)
        .post(`/issues/${digest.body.id}/children`)
        .send({ title: "Steward proposal: secret-scan: key in config", origin: { kind: AGENT_FINDING_ORIGIN_KIND, id: "secret:child" } });

    const first = await child();
    expect(first.status).toBe(201);
    const [row] = await db.select().from(issues).where(eq(issues.id, first.body.id));
    expect(row.originKind).toBe(AGENT_FINDING_ORIGIN_KIND);
    expect(row.originId).toBe("secret:child");

    expect((await child()).status).toBe(409);
    expect((await report(companyId, "secret:child")).status).toBe(409);
  });

  it("leaves issues without a finding key alone", async () => {
    const companyId = await seedCompany();
    const send = () => request(app).post(`/companies/${companyId}/issues`).send({ title: "Same title" });

    expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(201);
  });
});
