import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import type { PermissionKey } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { activityRoutes } from "../routes/activity.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent action audit route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const MISSING_PERMISSION = "Missing permission: audit:view_agent_actions";

describeEmbeddedPostgres("agent action audit routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-action-audit-");
    db = createDb(tempDb.connectionString);
  }, 90_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(actor: Record<string, unknown>) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    instance.use("/api", activityRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  function localBoard(companyId: string) {
    return { type: "board", userId: "local-board", companyIds: [companyId], source: "local_implicit", isInstanceAdmin: false };
  }

  // A signed-in person with an active membership and only these grants.
  async function member(
    companyId: string,
    keys: PermissionKey[],
    options: { membershipRole?: string; isInstanceAdmin?: boolean } = {},
  ) {
    const userId = `member-${randomUUID()}`;
    const membershipRole = options.membershipRole ?? "operator";
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole,
    });
    if (keys.length > 0) {
      await db.insert(principalPermissionGrants).values(
        keys.map((permissionKey) => ({ companyId, principalType: "user", principalId: userId, permissionKey })),
      );
    }
    return {
      type: "board",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole, status: "active" }],
      source: "session",
      isInstanceAdmin: options.isInstanceAdmin ?? false,
    };
  }

  async function seed() {
    const company = await db.insert(companies).values({
      name: "Audit Company",
      issuePrefix: `AU${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning().then((rows) => rows[0]!);
    const [agent, otherAgent] = await db.insert(agents).values([1, 2].map((index) => ({
      companyId: company.id,
      name: `Audit Agent ${index}`,
      role: "engineer",
      status: "active" as const,
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    }))).returning();
    const issue = await db.insert(issues).values({
      companyId: company.id,
      identifier: `${company.issuePrefix}-1`,
      title: "Audit target",
      status: "todo",
      priority: "medium",
    }).returning().then((rows) => rows[0]!);
    const comment = await db.insert(issueComments).values({
      companyId: company.id,
      issueId: issue.id,
      authorAgentId: agent!.id,
      body: "A useful comment excerpt for the audit feed.",
    }).returning().then((rows) => rows[0]!);
    const document = await db.insert(documents).values({
      companyId: company.id,
      title: "Plan",
      latestBody: "Plan body",
      createdByAgentId: agent!.id,
      updatedByAgentId: agent!.id,
    }).returning().then((rows) => rows[0]!);
    const issueDocument = await db.insert(issueDocuments).values({
      companyId: company.id,
      issueId: issue.id,
      documentId: document.id,
      key: "plan",
    }).returning().then((rows) => rows[0]!);
    const run = await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: agent!.id,
      responsibleUserId: "legacy-user",
    }).returning().then((rows) => rows[0]!);
    const base = new Date("2026-07-17T00:00:00.000Z");
    await db.insert(activityLog).values([
      { companyId: company.id, actorType: "agent", actorId: agent!.id, action: "issue.comment.created", entityType: "issue_comment", entityId: comment.id, agentId: agent!.id, runId: run.id, responsibleUserId: null, createdAt: new Date(base.getTime() + 3000) },
      { companyId: company.id, actorType: "system", actorId: "system", action: "issue.document.updated", entityType: "issue_document", entityId: issueDocument.id, agentId: agent!.id, runId: run.id, responsibleUserId: "direct-user", createdAt: new Date(base.getTime() + 2000) },
      { companyId: company.id, actorType: "agent", actorId: otherAgent!.id, action: "issue.updated", entityType: "issue", entityId: issue.id, agentId: otherAgent!.id, responsibleUserId: "other-user", createdAt: new Date(base.getTime() + 1000) },
    ]);
    return { company, agent: agent!, otherAgent: otherAgent!, issue, comment, issueDocument, run };
  }

  async function seedActorOnlyRows(companyId: string) {
    return db.insert(activityLog).values([
      {
        companyId,
        actorType: "user",
        actorId: "board-user",
        action: "company.updated",
        entityType: "company",
        entityId: companyId,
        responsibleUserId: "sensitive-responsible-user",
        details: { changed: "name" },
        createdAt: new Date("2026-07-17T00:00:06.000Z"),
      },
      {
        companyId,
        actorType: "system",
        actorId: "scheduler",
        action: "heartbeat.scheduled",
        entityType: "company",
        entityId: companyId,
        details: { schedule: "private-schedule" },
        createdAt: new Date("2026-07-17T00:00:05.000Z"),
      },
      {
        companyId,
        actorType: "plugin",
        actorId: "example-plugin",
        action: "plugin.synced",
        entityType: "company",
        entityId: companyId,
        details: { pluginConfig: "private-config" },
        createdAt: new Date("2026-07-17T00:00:04.000Z"),
      },
    ]).returning();
  }

  async function exportsLogged() {
    return (await db.select().from(activityLog)).filter((row) => row.action === "audit.exported");
  }

  describe("who may see agent actions", () => {
    it("lets a member with only the View agent audit actions grant read and export", async () => {
      const { company } = await seed();
      const http = request(app(await member(company.id, ["audit:view_agent_actions"])));

      const list = await http.get(`/api/companies/${company.id}/audit/agent-actions`);
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      expect(list.body.items).toHaveLength(3);
      expect(list.body.accessTier).toBe("full");

      const csv = await http.get(`/api/companies/${company.id}/audit/agent-actions.csv`);
      expect(csv.status, csv.text).toBe(200);
      expect(csv.text.trim().split("\r\n")).toHaveLength(4);
    });

    it("refuses a member without the grant, before reading the query, and logs no export", async () => {
      const { company } = await seed();
      const http = request(app(await member(company.id, ["agents:create", "pipelines:write"])));

      const list = await http.get(`/api/companies/${company.id}/audit/agent-actions`);
      expect(list.status, JSON.stringify(list.body)).toBe(403);
      expect(list.body.error).toBe(MISSING_PERMISSION);

      // Authorization comes before validation, so a bad query says nothing.
      const invalid = await http.get(`/api/companies/${company.id}/audit/agent-actions?limit=invalid`);
      expect(invalid.status).toBe(403);
      expect(invalid.body.error).toBe(MISSING_PERMISSION);

      const csv = await http.get(`/api/companies/${company.id}/audit/agent-actions.csv`);
      expect(csv.status).toBe(403);
      expect(csv.body.error).toBe(MISSING_PERMISSION);
      expect(await exportsLogged()).toHaveLength(0);
    });

    it("refuses agents, even an agent holding the grant", async () => {
      const { company, agent, otherAgent } = await seed();
      await db.insert(companyMemberships).values({
        companyId: company.id,
        principalType: "agent",
        principalId: otherAgent.id,
        status: "active",
        membershipRole: "member",
      });
      await db.insert(principalPermissionGrants).values({
        companyId: company.id,
        principalType: "agent",
        principalId: otherAgent.id,
        permissionKey: "audit:view_agent_actions",
      });

      for (const agentId of [agent.id, otherAgent.id]) {
        const http = request(app({ type: "agent", agentId, companyId: company.id, source: "agent_key" }));
        const list = await http.get(`/api/companies/${company.id}/audit/agent-actions`);
        expect(list.status, JSON.stringify(list.body)).toBe(403);
        const csv = await http.get(`/api/companies/${company.id}/audit/agent-actions.csv`);
        expect(csv.status, JSON.stringify(csv.body)).toBe(403);
      }
      expect(await exportsLogged()).toHaveLength(0);
    });

    it("keeps access for an instance admin without the grant and for the local board", async () => {
      const { company } = await seed();
      const admin = await member(company.id, [], { membershipRole: "viewer", isInstanceAdmin: true });

      for (const actor of [admin, localBoard(company.id)]) {
        const list = await request(app(actor)).get(`/api/companies/${company.id}/audit/agent-actions`);
        expect(list.status, JSON.stringify(list.body)).toBe(200);
        expect(list.body.items).toHaveLength(3);
        expect(list.body.accessTier).toBe("full");
      }
    });
  });

  it("gives a company member and an agent basic all-actor rows without attribution", async () => {
    const { company, agent } = await seed();
    await seedActorOnlyRows(company.id);
    const viewer = await member(company.id, [], { membershipRole: "viewer" });

    for (const actor of [viewer, { type: "agent", agentId: agent.id, companyId: company.id, source: "agent_key" }]) {
      const http = request(app(actor));
      const items: Array<Record<string, unknown>> = [];
      let cursor: string | null = null;
      do {
        const cursorQuery: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
        const response = await http.get(`/api/companies/${company.id}/audit/agent-actions?actorScope=all&limit=2${cursorQuery}`);
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect(response.body.accessTier).toBe("basic");
        items.push(...response.body.items);
        cursor = response.body.nextCursor;
      } while (cursor);

      expect(items).toHaveLength(6);
      expect(new Set(items.map((item) => item.actorType))).toEqual(new Set(["agent", "user", "system", "plugin"]));
      for (const item of items) {
        expect(item).toMatchObject({ agentId: null, runId: null, responsibleUserId: null, details: null });
      }
    }
  });

  it("refuses every filter to a basic all-actors reader", async () => {
    const { company, agent, issue, run } = await seed();
    const http = request(app(await member(company.id, [], { membershipRole: "viewer" })));
    const filters = [
      `agentId=${agent.id}`,
      "responsibleUserId=legacy-user",
      `runId=${run.id}`,
      "entityType=issue",
      `entityId=${issue.id}`,
      "action=issue.",
      "actorType=agent",
      "from=2026-07-17T00%3A00%3A00.000Z",
      "to=2026-07-18T00%3A00%3A00.000Z",
    ];

    for (const filter of filters) {
      const response = await http.get(`/api/companies/${company.id}/audit/agent-actions?actorScope=all&${filter}`);
      expect(response.status, filter).toBe(403);
      expect(response.body.error).toContain("audit:view_agent_actions");
    }
  });

  it("keeps the default scope to agent actions and gives permitted readers the full all-actors view", async () => {
    const { company } = await seed();
    const actorOnlyRows = await seedActorOnlyRows(company.id);
    const http = request(app(localBoard(company.id)));

    const defaultResponse = await http.get(`/api/companies/${company.id}/audit/agent-actions`);
    expect(defaultResponse.status, JSON.stringify(defaultResponse.body)).toBe(200);
    expect(defaultResponse.body.items).toHaveLength(3);
    expect(defaultResponse.body.items.map((item: { id: string }) => item.id)).not.toContain(actorOnlyRows[0]!.id);

    const allResponse = await http.get(`/api/companies/${company.id}/audit/agent-actions?actorScope=all`);
    expect(allResponse.status, JSON.stringify(allResponse.body)).toBe(200);
    expect(allResponse.body.accessTier).toBe("full");
    expect(allResponse.body.items).toHaveLength(6);
    expect(allResponse.body.items.find((item: { id: string }) => item.id === actorOnlyRows[0]!.id)).toMatchObject({
      responsibleUserId: "sensitive-responsible-user",
      details: { changed: "name" },
    });
  });

  it("returns a client error for invalid audit query parameters", async () => {
    const { company } = await seed();
    const http = request(app(localBoard(company.id)));

    for (const query of ["limit=invalid", "limit=201", "actorScope=unknown", "agentId=not-a-uuid", "from=not-a-date"]) {
      const response = await http.get(`/api/companies/${company.id}/audit/agent-actions?${query}`);
      expect(response.status, query).toBe(400);
      expect(response.body.error, query).toBe("Invalid agent action audit query");
    }

    const cursorResponse = await http.get(`/api/companies/${company.id}/audit/agent-actions?cursor=invalid`);
    expect(cursorResponse.status).toBe(400);
    expect(cursorResponse.body.error).toBe("Invalid audit cursor");

    const nonUuidCursor = Buffer.from(JSON.stringify({
      createdAt: "2026-07-17T00:00:00.000000Z",
      id: "not-a-uuid",
    }), "utf8").toString("base64url");
    const nonUuidCursorResponse = await http.get(
      `/api/companies/${company.id}/audit/agent-actions?cursor=${encodeURIComponent(nonUuidCursor)}`,
    );
    expect(nonUuidCursorResponse.status).toBe(400);
    expect(nonUuidCursorResponse.body.error).toBe("Invalid audit cursor");
  });

  it("preserves sub-millisecond cursor precision across pages", async () => {
    const { company, agent } = await seed();
    await db.delete(activityLog);
    const newerId = randomUUID();
    const olderId = randomUUID();
    await db.execute(sql`
      insert into activity_log (
        id, company_id, actor_type, actor_id, action, entity_type, entity_id, agent_id, created_at
      ) values
        (${newerId}::uuid, ${company.id}::uuid, 'agent', ${agent.id}, 'audit.precision', 'company', ${company.id}, ${agent.id}::uuid, '2026-07-17T00:00:00.001900Z'::timestamptz),
        (${olderId}::uuid, ${company.id}::uuid, 'agent', ${agent.id}, 'audit.precision', 'company', ${company.id}, ${agent.id}::uuid, '2026-07-17T00:00:00.001100Z'::timestamptz)
    `);
    const http = request(app(localBoard(company.id)));

    const first = await http.get(`/api/companies/${company.id}/audit/agent-actions?action=audit.precision&limit=1`);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.items.map((item: { id: string }) => item.id)).toEqual([newerId]);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await http.get(
      `/api/companies/${company.id}/audit/agent-actions?action=audit.precision&limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`,
    );
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.items.map((item: { id: string }) => item.id)).toEqual([olderId]);
    expect(second.body.nextCursor).toBeNull();
  });

  it("paginates, filters, enriches entities, and falls back to the run responsible user", async () => {
    const { company, agent, otherAgent, issue, comment, issueDocument, run } = await seed();
    const http = request(app(await member(company.id, ["audit:view_agent_actions"])));

    const first = await http.get(`/api/companies/${company.id}/audit/agent-actions?limit=1`);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.items).toHaveLength(1);
    expect(first.body.items[0].responsibleUserId).toBe("legacy-user");
    expect(first.body.items[0].entity.comment).toEqual({ id: comment.id, excerpt: "A useful comment excerpt for the audit feed." });
    expect(first.body.items[0].entity.issue).toMatchObject({ id: issue.id, identifier: issue.identifier, title: issue.title });
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await http.get(`/api/companies/${company.id}/audit/agent-actions?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(second.body.items[0].entity.document).toEqual({ id: expect.any(String), key: "plan" });

    const cases = [
      [`agentId=${agent.id}`, 2],
      ["responsibleUserId=legacy-user", 1],
      ["responsibleUserId=direct-user", 1],
      [`runId=${run.id}`, 2],
      ["entityType=issue_document", 1],
      [`entityId=${issueDocument.id}`, 1],
      ["action=issue.comment", 1],
      ["actorType=system", 1],
      ["from=2026-07-17T00%3A00%3A01.500Z&to=2026-07-17T00%3A00%3A02.500Z", 1],
      [`agentId=${otherAgent.id}`, 1],
    ] as const;
    for (const [query, count] of cases) {
      const response = await http.get(`/api/companies/${company.id}/audit/agent-actions?${query}`);
      expect(response.status, `${query}: ${JSON.stringify(response.body)}`).toBe(200);
      expect(response.body.items, query).toHaveLength(count);
    }
  });

  it("does not enrich hidden issues or mismatched entity types", async () => {
    const { company, agent, comment, run } = await seed();
    const hiddenIssue = await db.insert(issues).values({
      companyId: company.id,
      identifier: `${company.issuePrefix}-HIDDEN`,
      title: "Hidden audit target",
      status: "todo",
      priority: "medium",
      hiddenAt: new Date(),
    }).returning().then((rows) => rows[0]!);
    const hiddenComment = await db.insert(issueComments).values({
      companyId: company.id,
      issueId: hiddenIssue.id,
      authorAgentId: agent.id,
      body: "Hidden audit comment",
    }).returning().then((rows) => rows[0]!);
    const [hiddenActivity, hiddenDocumentActivity, mismatchedActivity] = await db.insert(activityLog).values([
      {
        companyId: company.id,
        actorType: "agent",
        actorId: agent.id,
        action: "issue.comment.created",
        entityType: "issue",
        entityId: hiddenIssue.id,
        agentId: agent.id,
        runId: run.id,
        details: {
          commentId: hiddenComment.id,
          bodySnippet: hiddenComment.body,
          identifier: hiddenIssue.identifier,
          issueTitle: hiddenIssue.title,
        },
      },
      {
        companyId: company.id,
        actorType: "agent",
        actorId: agent.id,
        action: "issue.document_updated",
        entityType: "issue",
        entityId: hiddenIssue.id,
        agentId: agent.id,
        runId: run.id,
        details: { documentId: randomUUID(), key: "plan", title: "Hidden document title" },
      },
      {
        companyId: company.id,
        actorType: "agent",
        actorId: agent.id,
        action: "company.updated",
        entityType: "company",
        entityId: comment.id,
        agentId: agent.id,
        runId: run.id,
      },
    ]).returning();

    const response = await request(app(localBoard(company.id))).get(`/api/companies/${company.id}/audit/agent-actions`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const find = (id: string) => response.body.items.find((item: { id: string }) => item.id === id);
    expect(find(hiddenActivity!.id)?.entity).toEqual({ issue: null, comment: null, document: null });
    expect(find(hiddenActivity!.id)?.details).toBeNull();
    expect(find(hiddenDocumentActivity!.id)?.details).toBeNull();
    expect(find(mismatchedActivity!.id)?.entity).toEqual({ issue: null, comment: null, document: null });
  });

  it("lists a row whose entity id is not a uuid instead of failing the page", async () => {
    const { company, agent } = await seed();
    const [badRow] = await db.insert(activityLog).values({
      companyId: company.id,
      actorType: "user",
      actorId: "board-user",
      action: "issue.updated",
      entityType: "issue",
      entityId: "not-a-uuid",
      agentId: agent.id,
      details: { note: "logged through the board" },
    }).returning();

    const response = await request(app(localBoard(company.id))).get(`/api/companies/${company.id}/audit/agent-actions`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.items).toHaveLength(4);
    const listed = response.body.items.find((item: { id: string }) => item.id === badRow!.id);
    expect(listed?.entity).toEqual({ issue: null, comment: null, document: null });
    expect(listed?.details).toBeNull();
  });

  it("never returns secret values held in details", async () => {
    const { company, agent } = await seed();
    // Written straight to the table, as rows from before a redaction rule were.
    await db.insert(activityLog).values({
      companyId: company.id,
      actorType: "agent",
      actorId: agent.id,
      action: "agent.updated",
      entityType: "agent",
      entityId: agent.id,
      agentId: agent.id,
      details: {
        apiKey: "sk-live-plain-key-value",
        adapterConfig: { env: { DATABASE_PASSWORD: "plain-db-password" } },
        sessionToken: "aaaaaaaa.bbbbbbbb.cccccccc",
        note: "visible note",
      },
    });
    const http = request(app(localBoard(company.id)));

    const list = await http.get(`/api/companies/${company.id}/audit/agent-actions?entityType=agent`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].details).toEqual({
      apiKey: "***REDACTED***",
      adapterConfig: { env: { DATABASE_PASSWORD: "***REDACTED***" } },
      sessionToken: "***REDACTED***",
      note: "visible note",
    });

    const csv = await http.get(`/api/companies/${company.id}/audit/agent-actions.csv`);
    expect(csv.status, csv.text).toBe(200);
    for (const response of [JSON.stringify(list.body), csv.text]) {
      expect(response).not.toContain("sk-live-plain-key-value");
      expect(response).not.toContain("plain-db-password");
      expect(response).not.toContain("aaaaaaaa.bbbbbbbb.cccccccc");
    }
  });

  it("exports CSV with spreadsheet formulas neutralised and logs the export", async () => {
    const { company, agent, issue, comment, issueDocument } = await seed();
    await db.update(issues).set({ title: "=2+2" }).where(eq(issues.id, issue.id));
    await db.update(issueComments).set({ body: "@SUM(A1), \"quoted\"" }).where(eq(issueComments.id, comment.id));
    await db.update(issueDocuments).set({ key: "+SUM(B1)" }).where(eq(issueDocuments.id, issueDocument.id));
    await db.insert(activityLog).values({
      companyId: company.id,
      actorType: "agent",
      actorId: agent.id,
      action: "note.added",
      entityType: "note",
      entityId: "-1+2",
      agentId: agent.id,
      createdAt: new Date("2026-07-16T00:00:00.000Z"),
    });
    const member1 = await member(company.id, ["audit:view_agent_actions"]);

    const response = await request(app(member1)).get(`/api/companies/${company.id}/audit/agent-actions.csv`);
    expect(response.status, response.text).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.headers["content-disposition"]).toContain(`agent-audit-${company.id}.csv`);

    const lines = response.text.trim().split("\r\n");
    expect(lines[0]).toBe(
      "createdAt,action,actorType,actorId,agentId,runId,responsibleUserId,entityType,entityId,issueIdentifier,issueTitle,commentExcerpt,documentKey",
    );
    // Four agent actions, four data rows (the export reads before it logs itself).
    expect(lines).toHaveLength(5);
    // Cells starting with =, +, - or @ are kept as text, not run as formulas.
    expect(response.text).toContain(",'=2+2,");
    expect(response.text).toContain(",\"'@SUM(A1), \"\"quoted\"\"\",");
    expect(response.text).toContain(",'+SUM(B1)");
    expect(response.text).toContain(",'-1+2,");
    expect(response.text).not.toMatch(/(^|,)[=+\-@]/m);

    // The export is itself recorded, with who did it.
    const logged = await exportsLogged();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      actorType: "user",
      actorId: member1.userId,
      entityType: "company",
      entityId: company.id,
    });
    expect(logged[0]!.details).toMatchObject({ format: "csv", rowCount: 4, truncated: false });
  });

  it("exports only the filtered rows", async () => {
    const { company, agent } = await seed();
    const response = await request(app(localBoard(company.id)))
      .get(`/api/companies/${company.id}/audit/agent-actions.csv?agentId=${agent.id}&action=issue.comment&limit=1&cursor=ignored`);
    expect(response.status, response.text).toBe(200);
    const lines = response.text.trim().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("issue.comment.created");

    const logged = await exportsLogged();
    expect(logged[0]!.details).toMatchObject({
      rowCount: 1,
      filters: { actorScope: "agents", agentId: agent.id, action: "issue.comment" },
    });
  });
});
