import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, agentWakeupRequests, approvals, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { approvalService } from "../services/approvals.js";
import { persistActivityLog } from "../services/activity-log.js";
import { rejectInstructionRule } from "../services/instruction-rule-rejections.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import { approvalDecisionService } from "../services/approval-decisions.js";
import { heartbeatService } from "../services/heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("instruction rule rejection", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rule-rejections-");
    db = createDb(tempDb.connectionString);
  }, 90_000);
  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(approvals);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });
  afterAll(async () => { await tempDb?.cleanup(); });

  async function seed(status = "pending") {
    const company = await db.insert(companies).values({
      name: `Rejection ${randomUUID()}`,
      issuePrefix: `RJ${randomUUID().replaceAll("-", "").slice(0, 6)}`,
    }).returning().then((rows) => rows[0]!);
    const agent = await db.insert(agents).values({
      companyId: company.id, name: "Requester", role: "engineer",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
    }).returning().then((rows) => rows[0]!);
    const issue = await db.insert(issues).values({
      companyId: company.id, title: "Source", assigneeAgentId: agent.id,
    }).returning().then((rows) => rows[0]!);
    const correction = await db.insert(issueComments).values({
      companyId: company.id, issueId: issue.id, authorType: "user",
      authorUserId: "board", intent: "correction", body: "Check totals.",
    }).returning().then((rows) => rows[0]!);
    const approval = await db.insert(approvals).values({
      companyId: company.id, type: "instruction_change", status,
      requestedByAgentId: agent.id,
      payload: {
        version: 1, scope: "agent", targetAgentId: agent.id,
        sourceIssueId: issue.id, sourceCommentId: correction.id, rule: "Check totals.",
      },
    }).returning().then((rows) => rows[0]!);
    return { company, agent, issue, approval };
  }

  it("rolls back a failed audit and commits one decision, receipt and event on retry", async () => {
    const { company, approval } = await seed();
    const published: string[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(company.id, (event) => {
      if (event.type === "activity.logged") published.push(String(event.payload.action));
    });
    try {
      await expect(rejectInstructionRule(db, approval.id, "board", "Not durable", {}, async () => {
        throw new Error("audit unavailable");
      })).rejects.toThrow("audit unavailable");
      expect(await approvalService(db).getById(approval.id)).toMatchObject({ status: "pending", decidedAt: null });
      expect(await db.select().from(activityLog)).toHaveLength(0);
      expect(await db.select().from(issueComments)).toHaveLength(1);
      expect(published).toEqual([]);

      await expect(approvalService(db).reject(approval.id, "board", "  Already covered.  ", {
        sourcePluginId: "slack", sourcePluginKey: "slack-tools",
      })).resolves.toMatchObject({ applied: true, approval: { status: "rejected" } });
      await expect(approvalService(db).reject(approval.id, "other-board", "Different note"))
        .resolves.toMatchObject({ applied: false, approval: { decidedByUserId: "board", decisionNote: "  Already covered.  " } });
      expect(await db.select().from(activityLog)).toEqual([expect.objectContaining({
        action: "approval.rejected", actorId: "board",
        details: { type: "instruction_change", sourcePluginId: "slack", sourcePluginKey: "slack-tools" },
      })]);
      expect(await db.select().from(issueComments).where(eq(issueComments.authorType, "system")))
        .toEqual([expect.objectContaining({ body: "Standing rule rejected: Already covered." })]);
      expect(published).toEqual(["approval.rejected"]);
    } finally { unsubscribe(); }
  });

  it("rolls back the decision and audit when the receipt cannot be persisted", async () => {
    const { approval } = await seed("revision_requested");
    await db.execute(sql`ALTER TABLE issue_comments ADD CONSTRAINT test_rejection_receipt CHECK (author_type IS DISTINCT FROM 'system')`);
    try {
      await expect(rejectInstructionRule(db, approval.id, "board", undefined, {}, persistActivityLog)).rejects.toThrow();
      expect(await approvalService(db).getById(approval.id)).toMatchObject({ status: "revision_requested", decidedAt: null });
      expect(await db.select().from(activityLog)).toHaveLength(0);
      expect(await db.select().from(issueComments)).toHaveLength(1);
    } finally {
      await db.execute(sql`ALTER TABLE issue_comments DROP CONSTRAINT test_rejection_receipt`);
    }
    await expect(approvalService(db).reject(approval.id, "board")).resolves.toMatchObject({ applied: true });
    expect(await db.select().from(issueComments).where(eq(issueComments.authorType, "system")))
      .toEqual([expect.objectContaining({ body: "Standing rule rejected by the board." })]);
  });

  it("applies concurrent retries once and preserves an approved decision", async () => {
    const { approval } = await seed();
    const results = await Promise.all(Array.from({ length: 4 }, () => approvalService(db).reject(approval.id, "board")));
    expect(results.filter((result) => result.applied)).toHaveLength(1);
    expect(await db.select().from(activityLog)).toHaveLength(1);
    expect(await db.select().from(issueComments).where(eq(issueComments.authorType, "system"))).toHaveLength(1);

    const approved = await seed("approved");
    await expect(approvalService(db).reject(approved.approval.id, "board")).rejects.toThrow("Only pending");
    expect(await approvalService(db).getById(approved.approval.id)).toMatchObject({ status: "approved" });
    expect(await db.select().from(activityLog)).toHaveLength(1);
  });

  it("allows rejection after deletion of its source comment or issue", async () => {
    const commentDeleted = await seed();
    await db.delete(issueComments).where(eq(issueComments.issueId, commentDeleted.issue.id));
    await expect(approvalService(db).reject(commentDeleted.approval.id, "board"))
      .resolves.toMatchObject({ applied: true, approval: { status: "rejected" } });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, commentDeleted.issue.id)))
      .toEqual([expect.objectContaining({ authorType: "system" })]);

    const issueDeleted = await seed();
    await db.delete(issueComments).where(eq(issueComments.issueId, issueDeleted.issue.id));
    await db.delete(issues).where(eq(issues.id, issueDeleted.issue.id));
    await expect(approvalService(db).reject(issueDeleted.approval.id, "board"))
      .resolves.toMatchObject({ applied: true, approval: { status: "rejected" } });
    await expect(approvalService(db).reject(issueDeleted.approval.id, "board"))
      .resolves.toMatchObject({ applied: false });
    expect(await db.select().from(activityLog)).toHaveLength(2);
    expect(await db.select().from(issueComments)).toHaveLength(1);
  });

  it("keeps one durable requester wake across concurrent rejection retries", async () => {
    const { company, agent, issue, approval } = await seed();
    await db.update(agents).set({ status: "running" }).where(eq(agents.id, agent.id));
    const run = await db.insert(heartbeatRuns).values({
      companyId: company.id, agentId: agent.id, invocationSource: "assignment",
      triggerDetail: "system", status: "running",
      contextSnapshot: { issueId: issue.id, taskId: issue.id },
    }).returning().then((rows) => rows[0]!);
    await db.update(issues).set({
      status: "blocked", executionRunId: run.id,
      executionAgentNameKey: "requester", executionLockedAt: new Date(),
    }).where(eq(issues.id, issue.id));
    const decisions = approvalDecisionService(db, { heartbeat: heartbeatService(db) });
    const input = { approvalId: approval.id, decidedByUserId: "board" };
    await expect(decisions.reject(input)).resolves.toMatchObject({ applied: true });
    const retries = await Promise.all(Array.from({ length: 3 }, () => decisions.reject(input)));
    expect(retries.every((retry) => !retry.applied)).toBe(true);
    expect(await db.select().from(agentWakeupRequests)).toEqual([expect.objectContaining({
      agentId: agent.id, status: "deferred_issue_execution",
      idempotencyKey: `approval:${approval.id}:requester-wakeup:rejected`,
      payload: expect.objectContaining({ approvalId: approval.id, approvalStatus: "rejected" }),
    })]);
    expect(await db.select().from(activityLog)).toHaveLength(1);
    expect(await db.select().from(issueComments).where(eq(issueComments.authorType, "system"))).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
  });

  it("retries issue-less delivery atomically and accepts one concurrent wake after source deletion", async () => {
    const { company, agent, issue, approval } = await seed();
    await db.delete(issueComments).where(eq(issueComments.issueId, issue.id));
    await db.delete(issues).where(eq(issues.id, issue.id));
    await db.update(agents).set({ status: "running" }).where(eq(agents.id, agent.id));
    await db.insert(heartbeatRuns).values({
      companyId: company.id, agentId: agent.id, invocationSource: "assignment",
      triggerDetail: "system", status: "running", contextSnapshot: { taskKey: "other-work" },
    });
    const decisions = approvalDecisionService(db, { heartbeat: heartbeatService(db) });
    const input = { approvalId: approval.id, decidedByUserId: "board" };
    await db.execute(sql`ALTER TABLE heartbeat_runs ADD CONSTRAINT test_rejection_wake CHECK (invocation_source <> 'automation')`);
    try {
      // Rejection commits even when delivery fails; no partial wake receipt survives.
      await expect(decisions.reject(input)).resolves.toMatchObject({ applied: true });
      expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
      expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
    } finally {
      await db.execute(sql`ALTER TABLE heartbeat_runs DROP CONSTRAINT test_rejection_wake`);
    }
    const retries = await Promise.all(Array.from({ length: 4 }, () => decisions.reject(input)));
    expect(retries.every((retry) => !retry.applied)).toBe(true);
    expect(await db.select().from(agentWakeupRequests)).toEqual([expect.objectContaining({
      agentId: agent.id, status: "queued",
      idempotencyKey: `approval:${approval.id}:requester-wakeup:rejected`,
      payload: { approvalId: approval.id, approvalStatus: "rejected", issueId: null },
    })]);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.status, "queued"));
    expect(runs).toEqual([expect.objectContaining({
      contextSnapshot: expect.objectContaining({ approvalId: approval.id, issueId: null, taskId: null }),
    })]);
    expect(await db.select().from(activityLog)).toHaveLength(1);
    expect(await db.select().from(issueComments)).toHaveLength(0);
  });
});
