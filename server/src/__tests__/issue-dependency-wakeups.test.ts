import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, agentRuntimeState, agentTaskSessions, agentWakeupRequests, companies,
  companySkills, createDb, documents, documentRevisions, heartbeatRuns, heartbeatRunEvents,
  issueComments, issueDocuments, issueRelations, issues, issueTerminalEvents, issueTreeHolds, issueTreeHoldMembers, projects,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";
import { issueTreeControlService } from "../services/issue-tree-control.js";
import { issueDependencyWakeupService } from "../services/issue-dependency-wakeups.js";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", async () => ({
  ...await vi.importActual<typeof import("../adapters/index.js")>("../adapters/index.js"),
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute }),
}));

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping issue dependency wake tests: ${support.reason}`);

describeDatabase("transactional issue dependency wakeups", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-dependency-wakes-");
    db = createDb(tempDb.connectionString);
  });
  afterAll(async () => { await tempDb?.cleanup(); });
  afterEach(async () => {
    if (execute.mock.calls.length > 0) {
      await vi.waitFor(async () => {
        const agentRows = await db.select().from(agents);
        expect(agentRows.every((agent) => agent.status !== "running")).toBe(true);
      }, { timeout: 10_000 });
      // Final environment and runtime-service cleanup follows agent status.
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await db.delete(activityLog);
    await db.delete(companySkills);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueRelations);
    await db.delete(issueTreeHoldMembers);
    await db.delete(issueTreeHolds);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentTaskSessions);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
    execute.mockReset();
  });

  async function fixture() {
    heartbeat = heartbeatService(db);
    const companyId = randomUUID();
    const agentId = randomUUID();
    const parentId = randomUUID();
    const childId = randomUUID();
    const busyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Dependency tests", issuePrefix: `T${companyId.slice(0, 6)}` });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Assignee", role: "engineer", status: "running",
      adapterType: "process", runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
    });
    // Occupy the agent's slot so tests inspect queued delivery independently
    // of adapter execution and its unrelated run-completion recovery.
    await db.insert(heartbeatRuns).values({ id: busyId, companyId, agentId, status: "running", contextSnapshot: {} });
    await db.insert(issues).values({ id: parentId, companyId, title: "Parent", status: "blocked", assigneeAgentId: agentId });
    await db.insert(issues).values({ id: childId, companyId, title: "Child", status: "todo", parentId });
    return { companyId, agentId, parentId, childId, busyId };
  }
  async function deliveries(companyId: string) {
    return db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId), sql`${agentWakeupRequests.idempotencyKey} like 'issue-dependency:%'`,
    ));
  }

  it("wakes a blocked parent when the last child closes through the issue service", async () => {
    const f = await fixture();
    await issueService(db).addComment(f.childId, "The child output is ready.", { userId: "board" });
    await issueService(db).update(f.childId, { status: "done" });
    expect(await deliveries(f.companyId)).toHaveLength(0);
    expect(await heartbeat.reconcileIssueDependencyWakeups()).toMatchObject({ processed: 1, retried: 0 });
    const requests = await deliveries(f.companyId);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ reason: "issue_children_completed", status: "queued", agentId: f.agentId });
    expect(requests[0].payload).toMatchObject({ issueId: f.parentId, childIssueSummaries: [expect.objectContaining({ summary: "The child output is ready." })] });
  });

  it("deduplicates concurrent raw SQL child closures, scans, and delivery retries", async () => {
    const f = await fixture();
    const siblingId = randomUUID();
    await db.insert(issues).values({ id: siblingId, companyId: f.companyId, title: "Sibling", status: "todo", parentId: f.parentId });
    await Promise.all([f.childId, siblingId].map((id) => db.execute(sql`update issues set status = 'done' where id = ${id}`)));
    await Promise.all([heartbeat.reconcileIssueDependencyWakeups(), heartbeat.reconcileIssueDependencyWakeups()]);
    expect(await deliveries(f.companyId)).toHaveLength(1);
    await db.update(issueTerminalEvents).set({ processedVersion: 0 });
    // A fresh service instance represents retrying after a process restart.
    await heartbeatService(db).reconcileIssueDependencyWakeups();
    expect(await deliveries(f.companyId)).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${f.parentId}`)).toHaveLength(1);
  });

  it("does not expose uncommitted closure or deliver a rolled back transition", async () => {
    const f = await fixture();
    await expect(db.transaction(async (tx) => {
      await tx.update(issues).set({ status: "done" }).where(eq(issues.id, f.childId));
      await heartbeat.reconcileIssueDependencyWakeups();
      expect(await deliveries(f.companyId)).toHaveLength(0);
      throw new Error("rollback closure");
    })).rejects.toThrow("rollback closure");
    await heartbeat.reconcileIssueDependencyWakeups();
    expect(await db.select().from(issueTerminalEvents)).toHaveLength(0);
    expect(await deliveries(f.companyId)).toHaveLength(0);
  });

  it("records a fresh generation for raw SQL reopen and reclose between ticks", async () => {
    const f = await fixture();
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.childId));
    await heartbeat.reconcileIssueDependencyWakeups();
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.childId));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.childId));
    await heartbeat.reconcileIssueDependencyWakeups();
    const requests = await deliveries(f.companyId);
    expect(requests).toHaveLength(2);
    expect(new Set(requests.map((row) => row.idempotencyKey)).size).toBe(2);
    expect(await db.select().from(issueTerminalEvents)).toMatchObject([{ version: 2, processedVersion: 2 }]);
  });

  it("retries enqueue failures and a crash after accepted delivery without a second wake", async () => {
    const f = await fixture();
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.childId));
    const beforeEnqueue = issueDependencyWakeupService(db, async () => { throw new Error("dispatch unavailable"); });
    expect(await beforeEnqueue.reconcile()).toMatchObject({ retried: 1 });
    expect(await deliveries(f.companyId)).toHaveLength(0);
    const afterEnqueue = issueDependencyWakeupService(db, async (agentId, options) => {
      await heartbeat.wakeup(agentId, options);
      throw new Error("process stopped before acknowledgement");
    });
    expect(await afterEnqueue.reconcile()).toMatchObject({ retried: 1 });
    expect(await heartbeat.reconcileIssueDependencyWakeups()).toMatchObject({ processed: 1, retried: 0 });
    expect(await deliveries(f.companyId)).toHaveLength(1);
  });

  it("wakes blocked dependents only once all blockers are done, including cancellation then completion", async () => {
    const f = await fixture();
    await db.update(issues).set({ parentId: null }).where(eq(issues.id, f.childId));
    const blockerId = randomUUID();
    await db.insert(issues).values({ id: blockerId, companyId: f.companyId, title: "Second blocker", status: "todo" });
    await db.insert(issueRelations).values([f.childId, blockerId].map((issueId) => ({ companyId: f.companyId, issueId, relatedIssueId: f.parentId, type: "blocks" })));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.childId));
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, blockerId));
    await heartbeat.reconcileIssueDependencyWakeups();
    expect(await deliveries(f.companyId)).toHaveLength(0);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockerId));
    await Promise.all([heartbeat.reconcileIssueDependencyWakeups(), heartbeat.reconcileIssueDependencyWakeups()]);
    expect(await deliveries(f.companyId)).toMatchObject([{ reason: "issue_blockers_resolved", payload: { issueId: f.parentId } }]);
  });

  it("shares one delivery when the same children are also the parent's blockers", async () => {
    const f = await fixture();
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: f.childId, relatedIssueId: f.parentId, type: "blocks" });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.childId));
    await heartbeat.reconcileIssueDependencyWakeups();
    expect(await deliveries(f.companyId)).toHaveLength(1);
  });

  it.each(["issue_children_completed", "issue_blockers_resolved"] as const)("runs a deferred %s wake after the assignee's current run ends", async (reason) => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.parentId, wakeReason: "issue_assigned" } }).where(eq(heartbeatRuns.id, f.busyId));
    await db.update(issues).set({ executionRunId: f.busyId, executionAgentNameKey: "assignee" }).where(eq(issues.id, f.parentId));
    if (reason === "issue_blockers_resolved") {
      await db.update(issues).set({ parentId: null }).where(eq(issues.id, f.childId));
      await db.insert(issueRelations).values({ companyId: f.companyId, issueId: f.childId, relatedIssueId: f.parentId, type: "blocks" });
    }
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.childId));
    await heartbeat.reconcileIssueDependencyWakeups();
    expect(await deliveries(f.companyId)).toMatchObject([{ status: "deferred_issue_execution" }]);
    expect(execute).not.toHaveBeenCalled();
    execute.mockImplementation(async ({ runId }: { runId: string }) => {
      await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.parentId, authorAgentId: f.agentId, createdByRunId: runId, body: "Followup received." });
      return { exitCode: 0, signal: null, timedOut: false, summary: "Followup completed." };
    });
    await heartbeat.cancelRun(f.busyId);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    const runId = execute.mock.calls[0][0].runId;
    await vi.waitFor(async () => expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0].status).toBe("succeeded"), { timeout: 10_000 });
    const run = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0];
    expect(run.contextSnapshot).toMatchObject({ issueId: f.parentId, wakeReason: reason });
  });

  it.each(["agent_pause", "tree_pause", "budget_company", "budget_agent", "budget_project"] as const)("preserves a deferred completion through %s until it is released", async (pauseMode) => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.parentId } }).where(eq(heartbeatRuns.id, f.busyId));
    await db.update(issues).set({ executionRunId: f.busyId, executionAgentNameKey: "assignee" }).where(eq(issues.id, f.parentId));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.childId));
    await heartbeat.reconcileIssueDependencyWakeups();
    expect(await deliveries(f.companyId)).toMatchObject([{ status: "deferred_issue_execution" }]);
    const tree = issueTreeControlService(db);
    const actor = { actorType: "user" as const, actorId: "board", userId: "board" };
    const hold = pauseMode === "tree_pause"
      ? await tree.createHold(f.companyId, f.parentId, { mode: "pause", actor })
      : null;
    const scopeType = pauseMode === "budget_company" ? "company" : pauseMode === "budget_project" ? "project" : "agent";
    const scopeId = scopeType === "company" ? f.companyId : scopeType === "agent" ? f.agentId : randomUUID();
    const budgetPause = pauseMode.startsWith("budget_");
    if (hold) {
      await tree.cancelUnclaimedWakeupsForTree(f.companyId, f.parentId, "Paused subtree", { preserveDependencyDeferrals: true });
    } else if (budgetPause) {
      if (scopeType === "company") {
        await db.update(companies).set({ status: "paused", pauseReason: "budget" }).where(eq(companies.id, f.companyId));
      } else if (scopeType === "project") {
        await db.insert(projects).values({ id: scopeId, companyId: f.companyId, name: "Paused project", pauseReason: "budget", pausedAt: new Date() });
        await db.update(issues).set({ projectId: scopeId }).where(eq(issues.id, f.parentId));
      } else {
        await db.update(agents).set({ status: "paused", pauseReason: "budget" }).where(eq(agents.id, f.agentId));
      }
      await heartbeat.cancelBudgetScopeWork({ companyId: f.companyId, scopeType, scopeId });
    } else {
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    }
    if (!budgetPause) await heartbeat.cancelRun(f.busyId);
    await heartbeatService(db).reconcileIssueDependencyWakeups();
    expect(execute).not.toHaveBeenCalled();
    expect(await deliveries(f.companyId)).toMatchObject([{ status: "deferred_issue_execution" }]);
    expect(await db.select().from(issueTerminalEvents)).toMatchObject([{ version: 1, processedVersion: 1 }]);
    if (hold) {
      await tree.releaseHold(f.companyId, f.parentId, hold.hold.id, { actor });
    } else if (budgetPause && scopeType === "company") {
      await db.update(companies).set({ status: "active", pauseReason: null, pausedAt: null }).where(eq(companies.id, f.companyId));
    } else if (budgetPause && scopeType === "project") {
      await db.update(projects).set({ pauseReason: null, pausedAt: null }).where(eq(projects.id, scopeId));
    } else {
      await db.update(agents).set({ status: "idle", pauseReason: null }).where(eq(agents.id, f.agentId));
    }
    execute.mockImplementation(async ({ runId }: { runId: string }) => {
      await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.parentId, authorAgentId: f.agentId, createdByRunId: runId, body: "Resumed completion received." });
      return { exitCode: 0, signal: null, timedOut: false, summary: "Followup completed." };
    });
    await heartbeatService(db).reconcileIssueDependencyWakeups();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    const runId = execute.mock.calls[0][0].runId;
    await vi.waitFor(async () => expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0].status).toBe("succeeded"), { timeout: 10_000 });
    await heartbeatService(db).reconcileIssueDependencyWakeups();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await deliveries(f.companyId)).toHaveLength(1);
  });

  it("promotes a later verified comment under a tree pause while preserving an earlier completion", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.parentId } }).where(eq(heartbeatRuns.id, f.busyId));
    await db.update(issues).set({ executionRunId: f.busyId, executionAgentNameKey: "assignee" }).where(eq(issues.id, f.parentId));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.childId));
    await heartbeat.reconcileIssueDependencyWakeups();
    const helperId = randomUUID();
    const commentId = randomUUID();
    await db.insert(agents).values({ id: helperId, companyId: f.companyId, name: "Helper", status: "idle", adapterType: "process" });
    await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.parentId, authorUserId: "board", body: "@Helper, please answer this question." });
    const tree = issueTreeControlService(db);
    const actor = { actorType: "user" as const, actorId: "board", userId: "board" };
    const hold = await tree.createHold(f.companyId, f.parentId, { mode: "pause", actor });
    await heartbeat.wakeup(helperId, {
      source: "automation", reason: "issue_comment_mentioned",
      payload: { issueId: f.parentId, commentId },
      requestedByActorType: "user", requestedByActorId: "board",
      contextSnapshot: { issueId: f.parentId, wakeReason: "issue_comment_mentioned", commentId, wakeCommentId: commentId, source: "comment.mention" },
    });
    const deferred = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.status, "deferred_issue_execution")).orderBy(agentWakeupRequests.requestedAt);
    expect(deferred.map((row) => row.agentId)).toEqual([f.agentId, helperId]);
    execute.mockImplementation(async ({ runId, agent }: { runId: string; agent: { id: string } }) => {
      await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.parentId, authorAgentId: agent.id, createdByRunId: runId, body: "Wake received." });
      return { exitCode: 0, signal: null, timedOut: false, summary: "Wake completed." };
    });
    await heartbeat.cancelRun(f.busyId);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(execute.mock.calls[0][0].agent.id).toBe(helperId);
    const helperRunId = execute.mock.calls[0][0].runId;
    await vi.waitFor(async () => expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, helperRunId)))[0].status).toBe("succeeded"), { timeout: 10_000 });
    expect(await deliveries(f.companyId)).toMatchObject([{ status: "deferred_issue_execution" }]);
    await tree.releaseHold(f.companyId, f.parentId, hold.hold.id, { actor });
    await heartbeat.reconcileIssueDependencyWakeups();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2), { timeout: 10_000 });
    expect(execute.mock.calls[1][0].agent.id).toBe(f.agentId);
    const completionRunId = execute.mock.calls[1][0].runId;
    await vi.waitFor(async () => expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, completionRunId)))[0].status).toBe("succeeded"), { timeout: 10_000 });
    await heartbeat.reconcileIssueDependencyWakeups();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it.each(["agent_termination", "tree_cancel"] as const)("discards a deferred completion after %s", async (operation) => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.parentId } }).where(eq(heartbeatRuns.id, f.busyId));
    await db.update(issues).set({ executionRunId: f.busyId, executionAgentNameKey: "assignee" }).where(eq(issues.id, f.parentId));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.childId));
    await heartbeat.reconcileIssueDependencyWakeups();
    if (operation === "agent_termination") {
      await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, f.agentId));
    } else {
      const tree = issueTreeControlService(db);
      const hold = await tree.createHold(f.companyId, f.parentId, {
        mode: "cancel", actor: { actorType: "user", actorId: "board", userId: "board" },
      });
      await tree.cancelUnclaimedWakeupsForTree(f.companyId, f.parentId, "Cancelled subtree", { preserveDependencyDeferrals: false });
      await tree.cancelIssueStatusesForHold(f.companyId, f.parentId, hold.hold.id);
    }
    await heartbeat.cancelRun(f.busyId);
    await heartbeatService(db).reconcileIssueDependencyWakeups();
    expect(execute).not.toHaveBeenCalled();
    const requests = await deliveries(f.companyId);
    expect(requests).toHaveLength(1);
    expect(requests[0].status).toBe(operation === "agent_termination" ? "failed" : "cancelled");
  });

  it("retains receipt keys when completion wakes merge into an existing deferred comment wake", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.parentId } }).where(eq(heartbeatRuns.id, f.busyId));
    await db.update(issues).set({ executionRunId: f.busyId, executionAgentNameKey: "assignee" }).where(eq(issues.id, f.parentId));
    await heartbeat.wakeup(f.agentId, { source: "automation", reason: "issue_commented", payload: { issueId: f.parentId, commentId: randomUUID() }, contextSnapshot: { issueId: f.parentId, wakeReason: "issue_commented" } });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.childId));
    await heartbeat.reconcileIssueDependencyWakeups();
    await db.update(issueTerminalEvents).set({ processedVersion: 0 });
    await heartbeatService(db).reconcileIssueDependencyWakeups();
    expect(await deliveries(f.companyId)).toMatchObject([{ status: "coalesced", reason: "issue_children_completed" }]);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.status, "deferred_issue_execution"))).toHaveLength(1);
  });

  it("promotes an accepted deferred completion after a crash before terminal-run cleanup", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.parentId } }).where(eq(heartbeatRuns.id, f.busyId));
    await db.update(issues).set({ executionRunId: f.busyId, executionAgentNameKey: "assignee" }).where(eq(issues.id, f.parentId));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.childId));
    await heartbeat.reconcileIssueDependencyWakeups();
    expect(await deliveries(f.companyId)).toMatchObject([{ status: "deferred_issue_execution" }]);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.busyId));
    // A newer terminal mention run must not hide the older execution lock.
    await db.insert(heartbeatRuns).values({
      companyId: f.companyId, agentId: f.agentId, status: "succeeded",
      createdAt: new Date(Date.now() + 2_000), contextSnapshot: { issueId: f.parentId },
    });
    // An unrelated running task keeps the promoted wake queued for inspection.
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running", contextSnapshot: {} });
    await heartbeatService(db).reconcileIssueDependencyWakeups();
    await heartbeatService(db).reconcileIssueDependencyWakeups();
    expect(await deliveries(f.companyId)).toMatchObject([{ status: "queued" }]);
    const runs = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued"),
      sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${f.parentId}`,
    ));
    expect(runs).toHaveLength(1);
    expect(runs[0].contextSnapshot).toMatchObject({ wakeReason: "issue_children_completed" });
  });

  it("keeps a policy-suppressed wake pending until the assignee can run", async () => {
    const f = await fixture();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.childId));
    expect(await heartbeat.reconcileIssueDependencyWakeups()).toMatchObject({ processed: 0, retried: 1 });
    expect(await deliveries(f.companyId)).toHaveLength(0);
    await db.update(agents).set({ status: "running" }).where(eq(agents.id, f.agentId));
    expect(await heartbeat.reconcileIssueDependencyWakeups()).toMatchObject({ processed: 1, retried: 0 });
    expect(await deliveries(f.companyId)).toHaveLength(1);
  });

  it("does not wake across malformed cross-company parent, relation, or assignee links", async () => {
    const f = await fixture();
    const otherCompanyId = randomUUID();
    const otherParentId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Private company", issuePrefix: `P${otherCompanyId.slice(0, 6)}`, kind: "personal", ownerUserId: "private-owner" });
    await db.insert(issues).values({ id: otherParentId, companyId: otherCompanyId, title: "Private parent", status: "blocked", assigneeAgentId: f.agentId });
    await db.update(issues).set({ parentId: otherParentId }).where(eq(issues.id, f.childId));
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: f.childId, relatedIssueId: otherParentId, type: "blocks" });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.childId));
    await heartbeat.reconcileIssueDependencyWakeups();
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });
});
