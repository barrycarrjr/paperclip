import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, issueComments, issues } from "@paperclipai/db";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const wakeup = vi.hoisted(() => vi.fn(async () => null));
vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => ({
    wakeup,
    getWakeupDelivery: vi.fn(async () => ({ status: "accepted" })),
    reportRunActivity: vi.fn(async () => undefined),
    getRun: vi.fn(async () => null),
    getActiveRunForAgent: vi.fn(async () => null),
    cancelRun: vi.fn(async () => null),
  }),
}));

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping correction policy parity tests: ${support.reason}`);

describeDatabase("atomic correction policy parity with PATCH", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  const companyId = randomUUID();
  const workerId = randomUUID();
  const reviewerId = randomUUID();
  const laterParticipantId = randomUUID();
  const ordinaryAssigneeId = randomUUID();
  const defaultReviewerId = randomUUID();

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-correction-policy-parity-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Correction policy parity", issuePrefix: "CPP" });
    await db.insert(agents).values([
      { id: workerId, companyId, name: "Worker" },
      { id: reviewerId, companyId, name: "Active reviewer" },
      { id: laterParticipantId, companyId, name: "Later participant" },
      { id: ordinaryAssigneeId, companyId, name: "New owner" },
      { id: defaultReviewerId, companyId, name: "New owner's automatic reviewer" },
    ]);
    for (const id of [workerId, reviewerId, laterParticipantId, ordinaryAssigneeId]) {
      await db.update(agents).set({ defaultReviewerAgentId: defaultReviewerId }).where(eq(agents.id, id));
    }
    const [{ issueRoutes }, { errorHandler }] = await Promise.all([
      import("../routes/issues.js"), import("../middleware/index.js"),
    ]);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", companyIds: [companyId], source: "local_implicit", isInstanceAdmin: true };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
  }, 90_000);

  beforeEach(() => wakeup.mockClear());
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  async function seedPendingIssue(stageType: "review" | "approval", drifted = false) {
    const policy = normalizeIssueExecutionPolicy({ stages: [
      { type: stageType, participants: [{ type: "agent", agentId: reviewerId }] },
      { type: "approval", participants: [{ type: "agent", agentId: laterParticipantId }] },
    ] })!;
    const state = {
      status: "pending" as const, currentStageId: policy.stages[0].id, currentStageIndex: 0, currentStageType: stageType,
      currentParticipant: { type: "agent" as const, agentId: reviewerId },
      returnAssignee: { type: "agent" as const, agentId: workerId },
      completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null, reviewRequest: null,
    };
    const [issue] = await db.insert(issues).values({
      companyId, title: "Inherited active stage", status: "in_review", assigneeAgentId: drifted ? workerId : reviewerId,
      executionPolicy: policy, executionPolicyExplicit: false, executionState: state,
    }).returning();
    return { issue, policy, state };
  }

  it.each([
    ["review", "return"], ["approval", "return"], ["review", "later"], ["approval", "later"],
  ] as const)("rejects unauthorized %s handoff to the %s participant equally for PATCH and correction", async (stageType, targetRole) => {
    const { issue, policy, state } = await seedPendingIssue(stageType);
    const targetAgentId = targetRole === "return" ? workerId : laterParticipantId;
    const patch = await request(app).patch(`/api/issues/${issue.id}`).send({
      assigneeAgentId: targetAgentId, assigneeUserId: null, comment: "Please correct the source.",
    });
    const correction = await request(app).post(`/api/issues/${issue.id}/comments`).send({
      body: "Please correct the source.", intent: "correction", idempotencyKey: "board.correction:v1_policy-parity",
      expectedAssigneeAgentId: targetAgentId, reassignToAgentId: targetAgentId,
    });
    expect(patch.status, JSON.stringify(patch.body)).toBe(422);
    expect(correction.status, JSON.stringify(correction.body)).toBe(patch.status);
    expect(correction.body.error).toBe(patch.body.error);
    expect(correction.body.error).toContain("Only the active reviewer or approver");
    const [stored] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(stored).toMatchObject({ status: "in_review", assigneeAgentId: reviewerId, executionPolicyExplicit: false, executionPolicy: policy, executionState: state });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id))).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, issue.id))).toHaveLength(0);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it.each(["review", "approval"] as const)("preserves inherited %s policy when restoring its current participant", async (stageType) => {
    for (const endpoint of ["patch", "correction"] as const) {
      const { issue, policy, state } = await seedPendingIssue(stageType, true);
      const response = endpoint === "patch"
        ? await request(app).patch(`/api/issues/${issue.id}`).send({ assigneeAgentId: reviewerId, assigneeUserId: null, comment: "Restore the current participant." })
        : await request(app).post(`/api/issues/${issue.id}/comments`).send({
          body: "Restore the current participant.", intent: "correction", idempotencyKey: "board.correction:v1_restore-participant",
          expectedAssigneeAgentId: reviewerId, reassignToAgentId: reviewerId,
        });
      expect(response.status, JSON.stringify(response.body)).toBe(endpoint === "patch" ? 200 : 201);
      const [stored] = await db.select().from(issues).where(eq(issues.id, issue.id));
      expect(stored).toMatchObject({ status: "in_review", assigneeAgentId: reviewerId, executionPolicyExplicit: false, executionPolicy: policy, executionState: state });
    }
  });

  it("derives the new owner's automatic review policy for an ordinary reassignment in both paths", async () => {
    for (const endpoint of ["patch", "correction"] as const) {
      const oldPolicy = normalizeIssueExecutionPolicy({ stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewerId }] }] })!;
      const [issue] = await db.insert(issues).values({
        companyId, title: "Ordinary new-owner handoff", status: "in_progress", assigneeAgentId: workerId,
        executionPolicy: oldPolicy, executionPolicyExplicit: false, executionState: null,
      }).returning();
      const response = endpoint === "patch"
        ? await request(app).patch(`/api/issues/${issue.id}`).send({ assigneeAgentId: ordinaryAssigneeId, assigneeUserId: null, comment: "Take over this work." })
        : await request(app).post(`/api/issues/${issue.id}/comments`).send({
          body: "Take over this work.", intent: "correction", idempotencyKey: "board.correction:v1_ordinary-handoff",
          expectedAssigneeAgentId: ordinaryAssigneeId, reassignToAgentId: ordinaryAssigneeId,
        });
      expect(response.status, JSON.stringify(response.body)).toBe(endpoint === "patch" ? 200 : 201);
      const [stored] = await db.select().from(issues).where(eq(issues.id, issue.id));
      expect(stored).toMatchObject({
        status: "in_progress", assigneeAgentId: ordinaryAssigneeId, executionPolicyExplicit: false, executionState: null,
        executionPolicy: { stages: [{ type: "review", participants: [{ type: "agent", agentId: defaultReviewerId }] }] },
      });
    }
  });

  it.each(["review", "approval"] as const)("restores a blocked pending %s to in_review in both comment paths", async (stageType) => {
    for (const endpoint of ["patch", "correction"] as const) {
      const { issue, policy, state } = await seedPendingIssue(stageType);
      await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issue.id));
      const correctionPayload = {
        body: "Continue the pending stage.", intent: "correction", idempotencyKey: "board.correction:v1_blocked-stage",
        expectedAssigneeAgentId: reviewerId, reopen: true,
      };
      const response = endpoint === "patch"
        ? await request(app).patch(`/api/issues/${issue.id}`).send({ comment: "Continue the pending stage.", reopen: true })
        : await request(app).post(`/api/issues/${issue.id}/comments`).send(correctionPayload);
      expect(response.status, JSON.stringify(response.body)).toBe(endpoint === "patch" ? 200 : 201);
      const [stored] = await db.select().from(issues).where(eq(issues.id, issue.id));
      expect(stored).toMatchObject({
        status: "in_review", assigneeAgentId: reviewerId, executionPolicy: policy, executionState: state,
        completedAt: null, cancelledAt: null,
      });
      if (endpoint === "correction") {
        const retry = await request(app).post(`/api/issues/${issue.id}/comments`).send(correctionPayload);
        expect(retry.status, JSON.stringify(retry.body)).toBe(200);
        expect(retry.body.id).toBe(response.body.id);
        expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id))).toHaveLength(1);
        expect(await db.select().from(activityLog).where(eq(activityLog.entityId, issue.id))).toEqual(expect.arrayContaining([
          expect.objectContaining({ action: "issue.updated", details: expect.objectContaining({ status: "in_review", reopenedFrom: "blocked" }) }),
        ]));
        expect(await db.select().from(issues).where(eq(issues.id, issue.id))).toMatchObject([{ status: "in_review", executionState: state }]);
      }
    }
  });

  it("still reopens a blocked issue without a review policy to todo", async () => {
    const [issue] = await db.insert(issues).values({
      companyId, title: "Blocked without review", status: "blocked", assigneeAgentId: workerId,
      executionPolicy: null, executionPolicyExplicit: false, executionState: null,
    }).returning();
    const response = await request(app).post(`/api/issues/${issue.id}/comments`).send({
      body: "Continue this work.", intent: "correction", idempotencyKey: "board.correction:v1_blocked-no-policy",
      expectedAssigneeAgentId: workerId, reopen: true,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(await db.select().from(issues).where(eq(issues.id, issue.id))).toMatchObject([{
      status: "todo", assigneeAgentId: workerId, executionPolicy: null, executionState: null,
    }]);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, issue.id))).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "issue.updated", details: expect.objectContaining({ status: "todo", reopenedFrom: "blocked" }) }),
    ]));
  });
});
