import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import {
  activityLog, agents, agentWakeupRequests, companies, createDb, heartbeatRuns,
  issueEmailDelegations, issues, plugins, projects,
} from "@paperclipai/db";
import { buildEmailHandoffOriginId } from "@paperclipai/shared";
import { buildHostServices } from "../services/plugin-host-services.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const eventBus = { forPlugin: () => ({ emit: async () => {}, subscribe: () => {}, clear: () => {} }) } as any;

describe("Email Tools plugin issue handoffs (real PostgreSQL)", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let host: ReturnType<typeof buildHostServices>;
  let companyId: string;
  let sourceCompanyId: string;
  let assigneeAgentId: string;
  let clerkId: string;
  let runId: string;
  let projectId: string;
  const pluginId = randomUUID();
  const mailbox = "shared-inbox";
  const messageId = "<routing-example@example.com>";
  const originId = buildEmailHandoffOriginId({ pluginId: "email-tools", mailbox, messageId })!;
  const canonicalOriginId = buildEmailHandoffOriginId({ pluginId, mailbox, messageId })!;

  beforeAll(async () => {
    // Deliberately no support-probe skip: this suite must actually exercise transactions.
    fixture = await startEmbeddedPostgresTestDatabase("paperclip-issue-83-core-");
    db = createDb(fixture.connectionString);
    await db.insert(plugins).values({ id: pluginId, pluginKey: "email-tools", packageName: "example-email-tools",
      version: "0.0.0", manifestJson: {} as any, status: "ready" });
    host = buildHostServices(db, pluginId, "email-tools", eventBus);
  }, 90_000);

  beforeEach(async () => {
    companyId = randomUUID();
    sourceCompanyId = randomUUID();
    assigneeAgentId = randomUUID();
    clerkId = randomUUID();
    runId = randomUUID();
    projectId = randomUUID();
    await db.insert(companies).values([companyId, sourceCompanyId].map((id) => ({
      id, name: "Example company", issuePrefix: `T${id.replaceAll("-", "").slice(0, 10).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    })));
    await db.insert(agents).values([
      { id: assigneeAgentId, companyId, name: "Example recipient", role: "general", status: "idle", adapterType: "process" },
      { id: clerkId, companyId: sourceCompanyId, name: "Example clerk", role: "general", status: "idle", adapterType: "process" },
    ]);
    await db.insert(projects).values({ id: projectId, companyId, name: "Example project" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId: sourceCompanyId, agentId: clerkId,
      status: "running", invocationSource: "manual" });
  });

  afterAll(async () => {
    try { host?.dispose(); }
    finally {
      try { if (db) await (db as any).$client.end(); }
      finally { await fixture?.cleanup(); }
    }
  });

  function input(overrides: Record<string, unknown> = {}) {
    return { companyId, title: "Example mail subject", description: "Synthetic mail body for the issue only.",
      projectId, assigneeAgentId, status: "todo", originKind: "email_handoff", originId,
      actorAgentId: clerkId, actorRunId: runId, ...overrides };
  }
  async function storedIssues() {
    return db.select().from(issues).where(eq(issues.companyId, companyId));
  }
  async function handoffs() {
    return db.select().from(issueEmailDelegations).where(eq(issueEmailDelegations.companyId, companyId));
  }
  async function createdActivity() {
    return db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.created")));
  }

  it("atomically creates canonical email tracking and preserves source actor provenance without waking", async () => {
    const issue = await host.issues.create(input());
    expect(issue).toMatchObject({ companyId, originKind: "email_handoff", originId: canonicalOriginId,
      assigneeAgentId, projectId, createdByAgentId: clerkId, originRunId: runId });
    expect(await handoffs()).toEqual([expect.objectContaining({ companyId, issueId: issue.id, pluginId,
      mailbox, messageId, sourceKey: canonicalOriginId, delegatedToAgentId: assigneeAgentId,
      delegatedByUserId: null, status: "delegated", folder: null })]);
    expect(await createdActivity()).toEqual([expect.objectContaining({ actorType: "plugin", actorId: pluginId,
      agentId: clerkId, runId, details: expect.objectContaining({ initiatingActorType: "agent",
        initiatingActorId: clerkId, initiatingRunId: runId, sourcePluginId: pluginId, sourcePluginKey: "email-tools" }) })]);
    const audit = JSON.stringify(await createdActivity());
    expect(audit).not.toContain("Synthetic mail body");
    expect(audit).not.toContain("Example mail subject");
    expect(audit).not.toContain(messageId);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toHaveLength(0);
  });

  it("records a board initiator in handed-over-by and issue provenance", async () => {
    const userId = randomUUID();
    const issue = await host.issues.create(input({ actorAgentId: null, actorRunId: null, actorUserId: userId }));
    expect(issue.createdByUserId).toBe(userId);
    expect((await handoffs())[0].delegatedByUserId).toBe(userId);
    expect((await createdActivity())[0].details).toMatchObject({ initiatingActorType: "user", initiatingUserId: userId });
  });

  it("replays after a lost reply, across host instances and plugin key/id aliases", async () => {
    const issue = await host.issues.create(input());
    const anotherHost = buildHostServices(db, pluginId, "email-tools", eventBus);
    try {
      const replay = await anotherHost.issues.create(input({ originId: canonicalOriginId, title: "Retry must not rewrite this" }));
      expect(replay.id).toBe(issue.id);
      expect(replay.title).toBe(issue.title);
      expect(await storedIssues()).toHaveLength(1);
      expect(await handoffs()).toHaveLength(1);
      expect(await createdActivity()).toHaveLength(1);
    } finally { anotherHost.dispose(); }
  });

  it("serializes concurrent identical requests before either record is created", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      host.issues.create(input({ originId: i % 2 ? canonicalOriginId : originId }))));
    expect(new Set(results.map((issue) => issue.id)).size).toBe(1);
    expect(await storedIssues()).toHaveLength(1);
    expect(await handoffs()).toHaveLength(1);
    expect(await createdActivity()).toHaveLength(1);
  }, 30_000);

  it("rolls back the issue, counter and audit if inserting the handoff fails, then permits a clean retry", async () => {
    await db.execute(sql`create function issue83_reject_handoff() returns trigger language plpgsql as $$
      begin raise exception 'synthetic handoff insert failure'; end $$`);
    await db.execute(sql`create trigger issue83_reject_handoff before insert on issue_email_delegations
      for each row execute function issue83_reject_handoff()`);
    try {
      await expect(host.issues.create(input())).rejects.toThrow(/synthetic handoff insert failure/);
      expect(await storedIssues()).toHaveLength(0);
      expect(await handoffs()).toHaveLength(0);
      expect(await createdActivity()).toHaveLength(0);
      const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
      expect(company.issueCounter).toBe(0);
    } finally {
      await db.execute(sql`drop trigger issue83_reject_handoff on issue_email_delegations`);
      await db.execute(sql`drop function issue83_reject_handoff()`);
    }
    expect((await host.issues.create(input())).id).toBeTruthy();
    expect(await storedIssues()).toHaveLength(1);
    expect(await handoffs()).toHaveLength(1);
  });

  it.each(["resolved", "handed_back", "re_delegated"])("replays a %s handoff without resurrecting it", async (status) => {
    const issue = await host.issues.create(input());
    const [handoff] = await handoffs();
    await db.update(issueEmailDelegations).set({ status }).where(eq(issueEmailDelegations.id, handoff.id));
    expect((await host.issues.create(input())).id).toBe(issue.id);
    expect(await storedIssues()).toHaveLength(1);
    expect(await handoffs()).toEqual([expect.objectContaining({ id: handoff.id, status })]);
    expect(await createdActivity()).toHaveLength(1);
  });

  it.each([
    { originId: undefined }, { originId: "garbage" }, { originId: 7 },
    { originId: "email:v1:msgid:email-tools:%:bad" },
    { originId: "email:v1:msgid:email-tools:%20:%3Cexample%40example.com%3E" },
    { originId: buildEmailHandoffOriginId({ pluginId: "other-plugin", mailbox, messageId }) },
    { originId: buildEmailHandoffOriginId({ pluginId: "email-tools", mailbox, messageId: "not-a-message-id" }) },
    { originId: buildEmailHandoffOriginId({ pluginId: "email-tools", mailbox, messageId: "<a@example.com>\r\nInjected" }) },
    { originId: buildEmailHandoffOriginId({ pluginId: "email-tools", mailbox, folder: "INBOX", uid: 1 }) },
    { assigneeAgentId: undefined }, { assigneeAgentId: "" }, { assigneeUserId: "example-user" },
  ])("rejects invalid source or missing agent before writes: %j", async (overrides) => {
    await expect(host.issues.create(input(overrides))).rejects.toThrow();
    expect(await storedIssues()).toHaveLength(0);
    expect(await handoffs()).toHaveLength(0);
    expect(await createdActivity()).toHaveLength(0);
  });

  it("refuses other plugins, even if their origin names themselves", async () => {
    const otherHost = buildHostServices(db, randomUUID(), "other-plugin", eventBus);
    try {
      await expect(otherHost.issues.create(input({ originId: buildEmailHandoffOriginId({ pluginId: "other-plugin", mailbox, messageId }) })))
        .rejects.toThrow(/Only Email Tools/);
      expect(await storedIssues()).toHaveLength(0);
    } finally { otherHost.dispose(); }
  });

  it("requires the canonical self installed plugin record", async () => {
    const otherHost = buildHostServices(db, randomUUID(), "email-tools", eventBus);
    try {
      await expect(otherHost.issues.create(input())).rejects.toThrow(/installed Email Tools/);
      expect(await storedIssues()).toHaveLength(0);
    } finally { otherHost.dispose(); }
  });

  it("keeps company checks on destination agent and project", async () => {
    await expect(host.issues.create(input({ assigneeAgentId: clerkId }))).rejects.toThrow();
    await expect(host.issues.create(input({ companyId: sourceCompanyId, assigneeAgentId: clerkId }))).rejects.toThrow();
    expect(await storedIssues()).toHaveLength(0);
    expect(await handoffs()).toHaveLength(0);
  });

  it.each(["pending_approval", "terminated"])("refuses a %s destination agent", async (status) => {
    await db.update(agents).set({ status }).where(eq(agents.id, assigneeAgentId));
    await expect(host.issues.create(input())).rejects.toThrow();
    expect(await storedIssues()).toHaveLength(0);
  });

  it("preserves existing assignment semantics for a paused agent without waking it", async () => {
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, assigneeAgentId));
    expect((await host.issues.create(input())).assigneeAgentId).toBe(assigneeAgentId);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toHaveLength(0);
  });

  it("does not deduplicate the same source across different destination companies", async () => {
    const first = await host.issues.create(input());
    const second = await host.issues.create(input({ companyId: sourceCompanyId, assigneeAgentId: clerkId, projectId: undefined }));
    expect(first.id).not.toBe(second.id);
    expect(second.companyId).toBe(sourceCompanyId);
  });

  it("preserves ordinary plugin origins and refuses origin rewriting", async () => {
    const ordinary = await host.issues.create(input({ originKind: undefined, originId: "external-example", status: "backlog" }));
    expect(ordinary.originKind).toBe("plugin:email-tools");
    expect(await handoffs()).toHaveLength(0);
    await expect(host.issues.create(input({ originKind: "manual" }))).rejects.toThrow(/originKind/);
    await expect(host.issues.update({ companyId, issueId: ordinary.id, patch: { originKind: "email_handoff" } })).rejects.toThrow(/originKind/);
    const email = await host.issues.create(input());
    await expect(host.issues.update({ companyId, issueId: email.id, patch: { originId: "replacement" } })).rejects.toThrow(/rewrite/);
  });

  it("still refuses an HQ agent's cross-company email handoff through the actual REST route", async () => {
    const [{ issueRoutes }, { errorHandler }] = await Promise.all([import("../routes/issues.js"), import("../middleware/index.js")]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", companyId: sourceCompanyId, agentId: clerkId, isPortfolioRootAgent: true, source: "agent_key" };
      next();
    });
    app.use(issueRoutes(db, {} as any, {}));
    app.use(errorHandler);
    const response = await request(app).post(`/companies/${companyId}/issues`).send({
      title: "Example unauthorized handoff", assigneeAgentId, origin: { kind: "email_handoff", id: originId },
    });
    expect(response.status).toBe(403);
    expect(await storedIssues()).toHaveLength(0);
    expect(await handoffs()).toHaveLength(0);
  });
});
