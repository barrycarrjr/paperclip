import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  documentRevisions,
  documents,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRelations,
  issueTreeHolds,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Stale-queue invalidation test run.\nCounts: items read 0; entries added 0; changes proposed 0.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat stale-queue invalidation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

type SeedOptions = {
  agentName?: string;
  agentRole?: string;
  maxConcurrentRuns?: number;
};

type SeedResult = {
  companyId: string;
  agentId: string;
};

describeEmbeddedPostgres("heartbeat stale queued-run invalidation", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-stale-queue-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await ensureIssueRelationsTable(db);
  }, 90_000);

  afterEach(async () => {
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Stale-queue invalidation test run.\nCounts: items read 0; entries added 0; changes proposed 0.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns);
      const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await db.delete(companySkills);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueRelations);
    await db.delete(issueTreeHolds);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(opts: SeedOptions = {}): Promise<SeedResult> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: opts.agentName ?? "ClaudeCoder",
      role: opts.agentRole ?? "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: opts.maxConcurrentRuns ?? 1,
        },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedQueuedRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    wakeReason: string;
    contextExtras?: Record<string, unknown>;
    invocationSource?: "assignment" | "automation";
  }) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: input.invocationSource ?? "assignment",
      triggerDetail: "system",
      reason: input.wakeReason,
      payload: { issueId: input.issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: input.invocationSource ?? "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: {
        issueId: input.issueId,
        wakeReason: input.wakeReason,
        ...(input.contextExtras ?? {}),
      },
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    return { runId, wakeupRequestId };
  }

  it("cancels queued runs when the issue assignee changes before the run starts", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentName: "OriginalCoder" });
    const replacementAgentId = randomUUID();
    await db.insert(agents).values({
      id: replacementAgentId,
      companyId,
      name: "ReplacementCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Reassigned task",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: replacementAgentId,
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_assignee_changed");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_assignee_changed" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("assignee changed");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("runs a correction wake addressed to a prior assignee", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentName: "OriginalCoder" });
    const replacementAgentId = randomUUID();
    await db.insert(agents).values({
      id: replacementAgentId,
      companyId,
      name: "ReplacementCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    const issueId = randomUUID();
    const commentId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review the original run",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: replacementAgentId,
    });
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorUserId: "board-user",
      intent: "correction",
      expectedAssigneeAgentId: agentId,
      body: "Revise the original output.",
    });
    const { runId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_commented",
      invocationSource: "automation",
      contextExtras: { commentId, wakeCommentId: commentId, source: "issue.comment" },
    });

    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]?.status === "succeeded"));

    const run = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("succeeded");
    expect(run?.errorCode).toBeNull();
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    "promotes a deferred correction after the current run completes (prior target %s)",
    async (priorTarget) => {
      const { companyId, agentId: currentAgentId } = await seedCompanyAndAgent({ agentName: "CurrentOwner" });
      const priorAgentId = randomUUID();
      await db.insert(agents).values({
        id: priorAgentId, companyId, name: "PriorOwner", role: "engineer", status: "active",
        adapterType: "codex_local", adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {},
      });
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId, companyId, title: "Finish current work before reviewing feedback", status: "todo", assigneeAgentId: currentAgentId,
      });
      const targetAgentId = priorTarget ? priorAgentId : currentAgentId;
      const completedAt = new Date();
      let releaseCompletion!: () => void;
      const completion = new Promise<void>((resolve) => { releaseCompletion = resolve; });
      const result = {
        exitCode: 0, signal: null, timedOut: false, errorMessage: null,
        summary: "Finished.\nCounts: items read 0; entries added 0; changes proposed 0.", provider: "test", model: "test-model",
      };
      const promotedIssueStates: Array<{ status: string; assigneeAgentId: string | null }> = [];
      mockAdapterExecute.mockImplementation(async () => {
        const [issue] = await db.select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId }).from(issues).where(eq(issues.id, issueId));
        promotedIssueStates.push(issue);
        return result;
      });
      mockAdapterExecute.mockImplementationOnce(async () => {
        await completion;
        await db.update(issues).set({ status: "done", completedAt }).where(eq(issues.id, issueId));
        return result;
      });
      try {
        const currentRun = await heartbeat.wakeup(currentAgentId, {
          source: "assignment", triggerDetail: "system", reason: "issue_assigned", payload: { issueId },
          contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
          requestedByActorType: "user", requestedByActorId: "board-user",
        });
        expect(currentRun).not.toBeNull();
        await vi.waitFor(() => expect(mockAdapterExecute).toHaveBeenCalledTimes(1));
        const [comment] = await db.insert(issueComments).values({
          companyId, issueId, authorUserId: "board-user", intent: "correction",
          expectedAssigneeAgentId: targetAgentId, body: "Correct your earlier source.",
        }).returning();
        expect(await heartbeat.wakeup(targetAgentId, {
          idempotencyKey: `correction:${comment.id}`,
          source: "automation", triggerDetail: "system", reason: "issue_commented", payload: { issueId, commentId: comment.id },
          contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented", wakeCommentId: comment.id, commentId: comment.id },
          requestedByActorType: "user", requestedByActorId: "board-user",
        })).toBeNull();
        const deferred = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, targetAgentId));
        expect(deferred.some((wake) => wake.status === "deferred_issue_execution")).toBe(true);
        expect(await heartbeat.getWakeupDelivery(targetAgentId, `correction:${comment.id}`)).toMatchObject({ status: "pending", reason: expect.stringContaining("waiting") });
        expect(await heartbeat.wakeup(targetAgentId, {
          idempotencyKey: `correction:coalesced:${comment.id}`,
          source: "automation", triggerDetail: "system", reason: "issue_commented", payload: { issueId, commentId: comment.id },
          contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented", wakeCommentId: comment.id, commentId: comment.id },
          requestedByActorType: "user", requestedByActorId: "board-user",
        })).toBeNull();
        expect(await heartbeat.getWakeupDelivery(targetAgentId, `correction:coalesced:${comment.id}`)).toMatchObject({ status: "pending", reason: expect.stringContaining("waiting") });
        releaseCompletion();
        await vi.waitFor(() => expect(promotedIssueStates.length).toBeGreaterThan(0), { timeout: 10_000 });
        expect(promotedIssueStates[0]).toMatchObject({ status: priorTarget ? "done" : "in_progress", assigneeAgentId: currentAgentId });
        const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
        expect(issue.assigneeAgentId).toBe(currentAgentId);
        expect(issue.status).toBe(priorTarget ? "done" : "in_progress");
        expect(issue.completedAt).toEqual(priorTarget ? completedAt : null);
        const promoted = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, targetAgentId));
        expect(promoted.some((run) => (run.contextSnapshot as Record<string, unknown> | null)?.wakeCommentId === comment.id)).toBe(true);
        expect(await heartbeat.getWakeupDelivery(targetAgentId, `correction:${comment.id}`)).toEqual({ status: "accepted" });
        expect(await heartbeat.getWakeupDelivery(targetAgentId, `correction:coalesced:${comment.id}`)).toEqual({ status: "accepted" });
        await vi.waitFor(async () => {
          const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, targetAgentId));
          expect(runs.every((run) => run.status === "succeeded")).toBe(true);
        }, { timeout: 10_000 });
      } finally {
        releaseCompletion();
      }
    },
  );

  it.each([
    ["issue_commented", "issue.comment"],
    ["issue_reopened_via_comment", "issue.comment.reopen"],
    ["issue_commented", "issue.comment.correction"],
    ["issue_reopened_via_comment", "issue.comment.correction"],
    ["issue_assigned", "issue.comment.correction"],
  ])("allows verified user correction %s from %s through a pause hold without allowing spoofed wakes", async (wakeReason, source) => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Paused correction", status: "todo", assigneeAgentId: agentId });
    const [hold] = await db.insert(issueTreeHolds).values({
      companyId, rootIssueId: issueId, mode: "pause", status: "active", reason: "Reviewing this issue", releasePolicy: { strategy: "manual" },
    }).returning();
    const [comment] = await db.insert(issueComments).values({
      companyId, issueId, authorUserId: "board-user", intent: "correction", expectedAssigneeAgentId: agentId,
      body: "Use the verified source.",
    }).returning();
    const contextSnapshot = { issueId, taskId: issueId, wakeReason, source, commentId: comment.id, wakeCommentId: comment.id };
    for (const actor of [
      { requestedByActorType: "agent" as const, requestedByActorId: agentId },
      { requestedByActorType: "system" as const, requestedByActorId: "automation" },
      { requestedByActorType: "user" as const, requestedByActorId: "different-user" },
      {},
    ]) {
      expect(await heartbeat.wakeup(agentId, {
        source: "automation", triggerDetail: "system", reason: wakeReason, payload: { issueId, commentId: comment.id }, contextSnapshot, ...actor,
      })).toBeNull();
    }
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId))).toMatchObject([
      { status: "skipped", reason: "issue_tree_hold_active" },
      { status: "skipped", reason: "issue_tree_hold_active" },
      { status: "skipped", reason: "issue_tree_hold_active" },
      { status: "skipped", reason: "issue_tree_hold_active" },
    ]);
    const accepted = await heartbeat.wakeup(agentId, {
      source: "automation", triggerDetail: "system", reason: wakeReason, payload: { issueId, commentId: comment.id }, contextSnapshot,
      requestedByActorType: "user", requestedByActorId: "board-user",
    });
    expect(accepted).not.toBeNull();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, accepted!.id));
    expect(run.contextSnapshot).toMatchObject({ treeHoldInteraction: true, activeTreeHold: { holdId: hold.id } });
    await vi.waitFor(() => expect(mockAdapterExecute).toHaveBeenCalled(), { timeout: 5_000 });
    expect(await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.id, hold.id))).toMatchObject([{ status: "active" }]);
    expect(await heartbeat.wakeup(agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_assigned", payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "issue_assigned", source: "issue.assignment" },
    })).toBeNull();
  });

  it("cancels queued runs when the issue reaches a terminal status before the run starts", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Already-completed task",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_terminal_status");
    expect(wakeup?.status).toBe("skipped");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("cancels queued in_review runs when the current participant changes before the run starts", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "ReviewerAgent",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "In-review task now owned by reviewer",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: otherAgentId, userId: null },
        returnAssignee: { type: "agent", agentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_review_participant_changed");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_review_participant_changed" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("in-review participant changed");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("still runs comment-driven wakes on in_review issues even when the agent is no longer the current participant", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "ReviewerAgent",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    const issueId = randomUUID();
    const commentId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "In-review task with comment feedback",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: otherAgentId, userId: null },
        returnAssignee: { type: "agent", agentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorAgentId: otherAgentId,
      body: "Review feedback comment",
    });

    const { runId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_commented",
      invocationSource: "automation",
      contextExtras: {
        commentId,
        wakeCommentId: commentId,
        source: "issue.comment",
      },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const run = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("succeeded");
    expect(run?.errorCode).toBeNull();
  });

  it.each([false, true, "ordinary"])("startup recovers a deferred correction after a terminal blocking run without duplicate delivery (merged receipt %s)", async (mergedReceipt) => {
    const { companyId, agentId: ownerId } = await seedCompanyAndAgent({ agentName: "CurrentOwner" });
    const targetId = randomUUID();
    await db.insert(agents).values({ id: targetId, companyId, name: "CorrectionTarget", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true } } });
    const [issue] = await db.insert(issues).values({ companyId, title: "Restore delivery after a process stopped", status: "in_progress", assigneeAgentId: ownerId }).returning();
    const [blocker] = await db.insert(heartbeatRuns).values({ companyId, agentId: ownerId, status: "running", startedAt: new Date(), invocationSource: "assignment", contextSnapshot: { issueId: issue.id } }).returning();
    await db.update(issues).set({ executionRunId: blocker.id, executionAgentNameKey: "currentowner", executionLockedAt: new Date() }).where(eq(issues.id, issue.id));
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", userId: "board-user", companyIds: [companyId], source: "local_implicit", isInstanceAdmin: true }; next(); });
    app.use("/api", issueRoutes(db, {} as any)); app.use(errorHandler);
    const firstPayload = { body: "Correct the earlier source.", intent: "correction", idempotencyKey: "handoff.review:restart-original", expectedAssigneeAgentId: targetId, allowPriorAssigneeTarget: true };
    const first = await request(app).post(`/api/issues/${issue.id}/comments`).send(firstPayload);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.correctionDelivery.status).toBe("pending");
    const payload = mergedReceipt === true ? { ...firstPayload, body: "Correct the second source.", idempotencyKey: "handoff.review:restart-merged" } : firstPayload;
    const selected = mergedReceipt === true ? await request(app).post(`/api/issues/${issue.id}/comments`).send(payload) : first;
    expect(selected.status, JSON.stringify(selected.body)).toBe(201);
    if (mergedReceipt === "ordinary") {
      const [ordinary] = await db.insert(issueComments).values({ companyId, issueId: issue.id, authorUserId: "board-user", intent: "message", body: "Additional ordinary context." }).returning();
      await heartbeat.wakeup(targetId, {
        source: "automation", reason: "issue_commented", requestedByActorType: "user", requestedByActorId: "board-user",
        payload: { issueId: issue.id, commentId: ordinary.id }, contextSnapshot: { issueId: issue.id, wakeCommentId: ordinary.id },
      });
      const [deferred] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, targetId), eq(agentWakeupRequests.status, "deferred_issue_execution")));
      expect(deferred.payload?.commentId).toBe(ordinary.id);
      expect((deferred.payload?._paperclipWakeContext as Record<string, unknown>)?.wakeCommentIds).toEqual(expect.arrayContaining([first.body.id, ordinary.id]));
    }
    const whileActive = await request(app).post(`/api/issues/${issue.id}/comments`).send(payload);
    expect(whileActive.body.correctionDelivery.status).toBe("pending");
    await heartbeatService(db).reconcileIssueDependencyWakeups();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, targetId))).toHaveLength(0);
    // Simulate the durable state left by a process stopping before promotion.
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, blocker.id));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issue.id));
    const restarted = heartbeatService(db);
    await restarted.resumeQueuedRuns();
    await Promise.all([restarted.reconcileIssueDependencyWakeups(), heartbeatService(db).reconcileIssueDependencyWakeups()]);
    await vi.waitFor(async () => { const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, targetId)); expect(runs).toMatchObject([{ status: "succeeded" }]); }, { timeout: 10_000 });
    const retry = await request(app).post(`/api/issues/${issue.id}/comments`).send(payload);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.id).toBe(selected.body.id);
    expect(retry.body.correctionDelivery).toEqual({ status: "accepted", pending: [] });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, targetId))).toHaveLength(1);
    expect(await db.select().from(issueComments).where(and(eq(issueComments.issueId, issue.id), eq(issueComments.intent, "correction")))).toHaveLength(mergedReceipt === true ? 2 : 1);
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    const finalIssue = await db.select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId }).from(issues).where(eq(issues.id, issue.id));
    expect(finalIssue).toMatchObject([{ assigneeAgentId: ownerId }]);
    if (mergedReceipt !== "ordinary") expect(finalIssue[0].status).toBe("done");
  });

  it("startup recovers a deferred correction mention for an agent other than the correction target", async () => {
    const { companyId, agentId: ownerId } = await seedCompanyAndAgent({ agentName: "CurrentOwner" });
    const mentionedAgentId = randomUUID();
    await db.insert(agents).values({
      id: mentionedAgentId, companyId, name: "MentionedReviewer", role: "reviewer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true } },
    });
    const [issue] = await db.insert(issues).values({
      companyId, title: "Recover mentioned reviewer delivery", status: "in_progress", assigneeAgentId: ownerId,
    }).returning();
    const [blocker] = await db.insert(heartbeatRuns).values({
      companyId, agentId: ownerId, status: "running", startedAt: new Date(),
      invocationSource: "assignment", contextSnapshot: { issueId: issue.id },
    }).returning();
    await db.update(issues).set({
      executionRunId: blocker.id, executionAgentNameKey: "currentowner", executionLockedAt: new Date(),
    }).where(eq(issues.id, issue.id));
    const [comment] = await db.insert(issueComments).values({
      companyId, issueId: issue.id, authorUserId: "board-user", intent: "correction",
      expectedAssigneeAgentId: ownerId, body: "@MentionedReviewer, verify the corrected source.",
    }).returning();

    await heartbeat.wakeup(mentionedAgentId, {
      idempotencyKey: `issue-comment:${comment.id}:mention:${mentionedAgentId}`,
      source: "automation", triggerDetail: "system", reason: "issue_comment_mentioned",
      payload: { issueId: issue.id, commentId: comment.id },
      requestedByActorType: "user", requestedByActorId: "board-user",
      contextSnapshot: {
        issueId: issue.id, taskId: issue.id, commentId: comment.id, wakeCommentId: comment.id,
        source: "comment.mention", wakeReason: "issue_comment_mentioned",
      },
    });
    expect(await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.agentId, mentionedAgentId),
      eq(agentWakeupRequests.status, "deferred_issue_execution"),
    ))).toHaveLength(1);

    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, blocker.id));
    const restarted = heartbeatService(db);
    await restarted.reconcileIssueDependencyWakeups();
    await vi.waitFor(async () => {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, mentionedAgentId));
      expect(runs).toMatchObject([{ status: "succeeded" }]);
    }, { timeout: 10_000 });
  });

  it("recovers a modern correction recipient once when another user's deferred wake owns the merged metadata", async () => {
    const { companyId, agentId: ownerId } = await seedCompanyAndAgent({ agentName: "CurrentOwner" });
    const mentionedAgentId = randomUUID();
    await db.insert(agents).values({
      id: mentionedAgentId, companyId, name: "MentionedReviewer", role: "reviewer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true } },
    });
    const [issue] = await db.insert(issues).values({
      companyId, title: "Recover the immutable correction recipient", status: "in_progress", assigneeAgentId: ownerId,
    }).returning();
    const [blocker] = await db.insert(heartbeatRuns).values({
      companyId, agentId: ownerId, status: "running", startedAt: new Date(),
      invocationSource: "assignment", contextSnapshot: { issueId: issue.id },
    }).returning();
    await db.update(issues).set({
      executionRunId: blocker.id, executionAgentNameKey: "currentowner", executionLockedAt: new Date(),
    }).where(eq(issues.id, issue.id));

    const [ordinaryComment] = await db.insert(issueComments).values({
      companyId, issueId: issue.id, authorUserId: "first-user", intent: "message",
      body: "Check the surrounding context.",
    }).returning();
    await heartbeat.wakeup(mentionedAgentId, {
      source: "automation", reason: "issue_commented",
      payload: { issueId: issue.id, commentId: ordinaryComment.id },
      requestedByActorType: "user", requestedByActorId: "first-user",
      contextSnapshot: { issueId: issue.id, wakeCommentId: ordinaryComment.id, source: "issue.comment" },
    });

    const [correction] = await db.insert(issueComments).values({
      companyId, issueId: issue.id, authorUserId: "correction-user", intent: "correction",
      expectedAssigneeAgentId: ownerId,
      correctionRecipientAgentIds: [ownerId, mentionedAgentId].sort(),
      body: "@MentionedReviewer, verify the corrected source.",
    }).returning();
    const correctionDeliveryKey = `issue-comment:${correction.id}:mention:${mentionedAgentId}`;
    await heartbeat.wakeup(mentionedAgentId, {
      idempotencyKey: correctionDeliveryKey,
      source: "automation", triggerDetail: "system", reason: "issue_comment_mentioned",
      payload: { issueId: issue.id, commentId: correction.id },
      requestedByActorType: "user", requestedByActorId: "correction-user",
      contextSnapshot: {
        issueId: issue.id, taskId: issue.id, commentId: correction.id, wakeCommentId: correction.id,
        source: "comment.mention", wakeReason: "issue_comment_mentioned",
      },
    });

    const [deferred] = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.agentId, mentionedAgentId),
      eq(agentWakeupRequests.status, "deferred_issue_execution"),
    ));
    expect(deferred.requestedByActorId).toBe("first-user");
    expect((deferred.payload?._paperclipWakeContext as Record<string, unknown>)?.wakeCommentIds)
      .toEqual(expect.arrayContaining([ordinaryComment.id, correction.id]));

    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, blocker.id));
    await Promise.all([
      heartbeatService(db).reconcileIssueDependencyWakeups(),
      heartbeatService(db).reconcileIssueDependencyWakeups(),
    ]);
    await vi.waitFor(async () => {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, mentionedAgentId));
      expect(runs).toMatchObject([{ status: "succeeded" }]);
    }, { timeout: 10_000 });

    expect(await heartbeat.wakeup(mentionedAgentId, {
      idempotencyKey: correctionDeliveryKey,
      source: "automation", triggerDetail: "system", reason: "issue_comment_mentioned",
      payload: { issueId: issue.id, commentId: correction.id },
      requestedByActorType: "user", requestedByActorId: "correction-user",
      contextSnapshot: {
        issueId: issue.id, taskId: issue.id, commentId: correction.id, wakeCommentId: correction.id,
        source: "comment.mention", wakeReason: "issue_comment_mentioned",
      },
    })).toBeNull();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, mentionedAgentId))).toHaveLength(1);
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent startup promotion for two prior targets on the same issue", async () => {
    const { companyId, agentId: ownerId } = await seedCompanyAndAgent({ agentName: "CurrentOwner" });
    const targetIds = [randomUUID(), randomUUID()];
    await db.insert(agents).values(targetIds.map((id, index) => ({ id, companyId, name: `PriorTarget${index}`, role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true } } })));
    const [issue] = await db.insert(issues).values({ companyId, title: "One issue execution at a time", status: "in_progress", assigneeAgentId: ownerId }).returning();
    const [blocker] = await db.insert(heartbeatRuns).values({ companyId, agentId: ownerId, status: "running", startedAt: new Date(), invocationSource: "assignment", contextSnapshot: { issueId: issue.id } }).returning();
    await db.update(issues).set({ executionRunId: blocker.id, executionAgentNameKey: "currentowner", executionLockedAt: new Date() }).where(eq(issues.id, issue.id));
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", userId: "board-user", companyIds: [companyId], source: "local_implicit", isInstanceAdmin: true }; next(); });
    app.use("/api", issueRoutes(db, {} as any)); app.use(errorHandler);
    for (const targetId of targetIds) {
      const response = await request(app).post(`/api/issues/${issue.id}/comments`).send({ body: "Correct your earlier source.", intent: "correction", idempotencyKey: `handoff.review:parallel-${targetId}`, expectedAssigneeAgentId: targetId, allowPriorAssigneeTarget: true });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
    }
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, blocker.id));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issue.id));
    let finishFirst!: () => void;
    const firstWork = new Promise<void>((resolve) => { finishFirst = resolve; });
    const result = { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Finished.\nCounts: items read 0; entries added 0; changes proposed 0.", provider: "test", model: "test-model" };
    mockAdapterExecute.mockImplementation(async () => result);
    mockAdapterExecute.mockImplementationOnce(async () => { await firstWork; return result; });
    try {
      await Promise.all(Array.from({ length: 4 }, () => heartbeatService(db).reconcileIssueDependencyWakeups()));
      await vi.waitFor(() => expect(mockAdapterExecute).toHaveBeenCalledTimes(1), { timeout: 10_000 });
      const pendingRuns = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), sql`${heartbeatRuns.agentId} IN (${targetIds[0]}, ${targetIds[1]})`));
      expect(pendingRuns).toMatchObject([{ status: "running" }]);
      expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.status, "deferred_issue_execution")))).toHaveLength(1);
      finishFirst();
      await vi.waitFor(async () => {
        const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), sql`${heartbeatRuns.agentId} IN (${targetIds[0]}, ${targetIds[1]})`));
        expect(runs).toMatchObject([{ status: "succeeded" }, { status: "succeeded" }]);
      }, { timeout: 10_000 });
      expect(mockAdapterExecute).toHaveBeenCalledTimes(2);
    } finally { finishFirst(); }
  });

  it.each([false, true])("retries a budget-cancelled deferred correction through the route exactly once (merged receipt %s)", async (mergedReceipt) => {
    const { companyId, agentId: ownerId } = await seedCompanyAndAgent({ agentName: "CurrentOwner" });
    const targetId = randomUUID();
    await db.insert(agents).values({ id: targetId, companyId, name: "CorrectionTarget", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true } } });
    const [issue] = await db.insert(issues).values({ companyId, title: "Recover cancelled correction delivery", status: "todo", assigneeAgentId: ownerId }).returning();
    let finishOwner!: () => void;
    const ownerWork = new Promise<void>((resolve) => { finishOwner = resolve; });
    const result = { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Finished.\nCounts: items read 0; entries added 0; changes proposed 0.", provider: "test", model: "test-model" };
    mockAdapterExecute.mockImplementation(async () => result);
    mockAdapterExecute.mockImplementationOnce(async () => { await ownerWork; await db.update(issues).set({ status: "done" }).where(eq(issues.id, issue.id)); return result; });
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", userId: "board-user", companyIds: [companyId], source: "local_implicit", isInstanceAdmin: true }; next(); });
    app.use("/api", issueRoutes(db, {} as any)); app.use(errorHandler);
    try {
      const ownerRun = await heartbeat.wakeup(ownerId, { source: "assignment", reason: "issue_assigned", payload: { issueId: issue.id }, contextSnapshot: { issueId: issue.id } });
      await vi.waitFor(() => expect(mockAdapterExecute).toHaveBeenCalledTimes(1));
      const originalPayload = { body: "Correct the earlier source.", intent: "correction", idempotencyKey: "handoff.review:budget-original", expectedAssigneeAgentId: targetId, allowPriorAssigneeTarget: true };
      const first = await request(app).post(`/api/issues/${issue.id}/comments`).send(originalPayload);
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(first.body.correctionDelivery.status).toBe("pending");
      const payload = mergedReceipt ? { ...originalPayload, body: "Correct the second source.", idempotencyKey: "handoff.review:budget-merged" } : originalPayload;
      const selected = mergedReceipt ? await request(app).post(`/api/issues/${issue.id}/comments`).send(payload) : first;
      expect(selected.status, JSON.stringify(selected.body)).toBe(201);
      const key = `issue-comment:${selected.body.id}:assignee:${targetId}`;
      await db.update(agents).set({ status: "paused", pauseReason: "budget" }).where(eq(agents.id, targetId));
      await heartbeat.cancelBudgetScopeWork({ companyId, scopeType: "agent", scopeId: targetId });
      const receipts = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, targetId));
      expect(receipts.some((receipt) => receipt.status === "cancelled" && receipt.runId === null)).toBe(true);
      if (mergedReceipt) expect(receipts.some((receipt) => receipt.idempotencyKey === key && receipt.status === "coalesced")).toBe(true);
      finishOwner();
      await vi.waitFor(async () => { const [run] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, ownerRun!.id)); expect(run.status).toBe("succeeded"); }, { timeout: 10_000 });
      await db.update(agents).set({ status: "active", pauseReason: null }).where(eq(agents.id, targetId));
      const retries = await Promise.all(Array.from({ length: 3 }, () => request(app).post(`/api/issues/${issue.id}/comments`).send(payload)));
      for (const retry of retries) {
        expect(retry.status, JSON.stringify(retry.body)).toBe(200);
        expect(retry.body.id).toBe(selected.body.id);
        expect(retry.body.correctionDelivery).toEqual({ status: "accepted", pending: [] });
      }
      await vi.waitFor(async () => { const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, targetId)); expect(runs).toMatchObject([{ status: "succeeded" }]); }, { timeout: 10_000 });
      const duplicate = await request(app).post(`/api/issues/${issue.id}/comments`).send(payload);
      expect(duplicate.body.correctionDelivery).toEqual({ status: "accepted", pending: [] });
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, targetId))).toHaveLength(1);
      expect(await db.select().from(issueComments).where(and(eq(issueComments.issueId, issue.id), eq(issueComments.intent, "correction")))).toHaveLength(mergedReceipt ? 2 : 1);
      const history = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, key));
      expect(history.some((receipt) => receipt.status === "skipped" && receipt.reason === "delivery_undelivered_terminal")).toBe(true);
    } finally { finishOwner(); }
  });

  it("retries a cancelled issue-less wake under the agent lock without duplicate runs", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const key = "cancelled-issue-less";
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", status: "cancelled", idempotencyKey: key, finishedAt: new Date() });
    await Promise.all(Array.from({ length: 3 }, () => heartbeat.wakeup(agentId, { source: "automation", idempotencyKey: key })));
    await vi.waitFor(async () => { const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)); expect(runs).toMatchObject([{ status: "succeeded" }]); }, { timeout: 10_000 });
    expect(await heartbeat.wakeup(agentId, { source: "automation", idempotencyKey: key })).toBeNull();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).toHaveLength(1);
  });

  it.each(["done", "in_progress"])("reports disabled on-demand correction delivery as pending on a %s issue and retries once enabled", async (status) => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: false } } }).where(eq(agents.id, agentId));
    const [issue] = await db.insert(issues).values({ companyId, title: "Disabled correction wake", status, assigneeAgentId: agentId }).returning();
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", userId: "board-user", companyIds: [companyId], source: "local_implicit", isInstanceAdmin: true }; next(); });
    app.use("/api", issueRoutes(db, {} as any)); app.use(errorHandler);
    const payload = { body: "Check the source.", intent: "correction", idempotencyKey: "handoff.review:disabled-wake", expectedAssigneeAgentId: agentId };
    const first = await request(app).post(`/api/issues/${issue.id}/comments`).send(payload);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.correctionDelivery).toMatchObject({ status: "pending", pending: [{ agentId, reason: expect.stringContaining("On-demand agent wakeups are disabled") }] });
    const key = `issue-comment:${first.body.id}:assignee:${agentId}`;
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, key))).toMatchObject([{ status: "skipped", reason: "heartbeat.wakeOnDemand.disabled" }]);
    await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: true } } }).where(eq(agents.id, agentId));
    const retry = await request(app).post(`/api/issues/${issue.id}/comments`).send(payload);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.id).toBe(first.body.id);
    expect(retry.body.correctionDelivery).toEqual({ status: "accepted", pending: [] });
    const duplicate = await request(app).post(`/api/issues/${issue.id}/comments`).send(payload);
    expect(duplicate.status, JSON.stringify(duplicate.body)).toBe(200);
    expect(duplicate.body.correctionDelivery).toEqual({ status: "accepted", pending: [] });
    expect(await db.select().from(issueComments).where(and(eq(issueComments.issueId, issue.id), eq(issueComments.intent, "correction")))).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).toHaveLength(1);
    await vi.waitFor(async () => {
      const [run] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      expect(run.status).toBe("succeeded");
    }, { timeout: 10_000 });
  });

  it("keeps an accepted correction accepted when an exact replay arrives after the agent is paused", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const [issue] = await db.insert(issues).values({
      companyId, title: "Keep accepted delivery durable", status: "todo", assigneeAgentId: agentId,
    }).returning();
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board", userId: "board-user", companyIds: [companyId],
        source: "local_implicit", isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any)); app.use(errorHandler);
    const payload = {
      body: "Check the accepted source.", intent: "correction",
      idempotencyKey: "handoff.review:accepted-before-pause", expectedAssigneeAgentId: agentId,
    };
    const first = await request(app).post(`/api/issues/${issue.id}/comments`).send(payload);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.correctionDelivery).toEqual({ status: "accepted", pending: [] });
    await vi.waitFor(async () => {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      expect(runs).toMatchObject([{ status: "succeeded" }]);
    }, { timeout: 10_000 });

    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));
    const replay = await request(app).post(`/api/issues/${issue.id}/comments`).send(payload);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.correctionDelivery).toEqual({ status: "accepted", pending: [] });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).toHaveLength(1);
  });

  it.each(["paused", "terminated", "pending_approval", "budget_paused"])("reports %s invocation refusal as a correction delivery block", async (state) => {
    const { agentId } = await seedCompanyAndAgent();
    await db.update(agents).set({
      status: state === "budget_paused" ? "paused" : state,
      pauseReason: state === "budget_paused" ? "budget" : null,
    }).where(eq(agents.id, agentId));
    await expect(heartbeat.wakeup(agentId, { source: "automation", idempotencyKey: "correction-blocked" })).rejects.toMatchObject({
      status: 409, details: { code: "invocation_blocked" },
    });
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("baseline: runs queued runs when the issue is in_progress with the same assignee", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Still actionable",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const { runId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const run = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("succeeded");
    expect(run?.errorCode).toBeNull();
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  });
});
