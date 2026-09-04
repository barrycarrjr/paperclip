import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import express from "express";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issueEmailDelegations,
  issueReferenceMentions,
  issues,
} from "@paperclipai/db";
import { EMAIL_HANDOFF_ORIGIN_KIND, buildEmailHandoffOriginId } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue-create delegation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * Proves the handover is tracked as a side effect of creating the issue.
 *
 * This is the wiring that makes the delegation real: both of the UI's handoff
 * paths go through this route, so tracking here is what stops either of them
 * from forgetting.
 */
describeEmbeddedPostgres("creating an issue from an email records the delegation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
  let companyId!: string;
  let userId!: string;

  const sourceKey = buildEmailHandoffOriginId({
    pluginId: "email-tools",
    mailbox: "personal",
    messageId: "<invoice-question@customer.example>",
  })!;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-delegation-");
    db = createDb(tempDb.connectionString);

    const [{ errorHandler }, { issueRoutes }] = await Promise.all([
      import("../middleware/index.js"),
      import("../routes/issues.js"),
    ]);

    userId = randomUUID();
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId,
        companyIds: [companyId],
        source: "session",
        isInstanceAdmin: true,
      };
      next();
    });
    app.use(issueRoutes(db, {} as any, {}));
    app.use(errorHandler);
  }, 30_000);

  afterEach(async () => {
    // Order matters: creating an issue through the route also writes an
    // activity row, and both it and the delegation reference the company.
    await db.delete(activityLog);
    await db.delete(issueReferenceMentions);
    await db.delete(issueEmailDelegations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  }

  it("tracks the handover, deriving everything from the origin key", async () => {
    await seedCompany();

    const res = await request(app)
      .post(`/companies/${companyId}/issues`)
      .send({
        title: "Customer asked about an invoice",
        origin: { kind: EMAIL_HANDOFF_ORIGIN_KIND, id: sourceKey },
      });

    expect(res.status).toBeLessThan(300);

    const [delegation] = await db.select().from(issueEmailDelegations);
    expect(delegation).toBeDefined();
    expect(delegation.status).toBe("delegated");
    expect(delegation.sourceKey).toBe(sourceKey);
    // Read out of the key rather than sent separately, so the client cannot
    // supply a mailbox that disagrees with the message it names.
    expect(delegation.pluginId).toBe("email-tools");
    expect(delegation.mailbox).toBe("personal");
    expect(delegation.messageId).toBe("<invoice-question@customer.example>");
    expect(delegation.delegatedByUserId).toBe(userId);
  });

  it("does not track an issue that did not come from an email", async () => {
    await seedCompany();

    const res = await request(app)
      .post(`/companies/${companyId}/issues`)
      .send({ title: "Someone typed this by hand" });

    expect(res.status).toBeLessThan(300);
    expect(await db.select().from(issueEmailDelegations)).toHaveLength(0);
  });

  it("still creates the issue when the origin key is unreadable", async () => {
    await seedCompany();

    const res = await request(app)
      .post(`/companies/${companyId}/issues`)
      .send({
        title: "Handoff with a broken reference",
        origin: { kind: EMAIL_HANDOFF_ORIGIN_KIND, id: "not-a-real-key" },
      });

    expect(res.status).toBeLessThan(300);
    expect(await db.select().from(issues)).toHaveLength(1);
    expect(await db.select().from(issueEmailDelegations)).toHaveLength(0);
  });

  it("does not hand the same email over twice", async () => {
    await seedCompany();

    const body = {
      title: "Customer asked about an invoice",
      origin: { kind: EMAIL_HANDOFF_ORIGIN_KIND, id: sourceKey },
    };
    await request(app).post(`/companies/${companyId}/issues`).send(body);
    await request(app).post(`/companies/${companyId}/issues`).send(body);

    // Two clicks make two issues — that is the existing behaviour and not
    // this change's business. What must not happen is the same email being
    // tracked as handed over twice at once.
    expect(await db.select().from(issues)).toHaveLength(2);
    expect(await db.select().from(issueEmailDelegations)).toHaveLength(1);
  });
});
