import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  heartbeatRunEvents,
  issueComments,
  issueExecutionDecisions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildHostServices } from "../services/plugin-host-services.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: async () => {},
        subscribe: () => {},
      };
    },
  } as any;
}

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plugin orchestration API tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("plugin orchestration APIs", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-orchestration-");
    db = createDb(tempDb.connectionString);
  }, 90_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueExecutionDecisions);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: "true" },
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("creates plugin-origin issues with full orchestration fields and audit activity", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const blockerIssueId = randomUUID();
    const originRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: originRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: { issueId: blockerIssueId },
    });
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId,
      title: "Blocker",
      status: "todo",
      priority: "medium",
      identifier: `${issuePrefix(companyId)}-blocker`,
    });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());
    const issue = await services.issues.create({
      companyId,
      title: "Plugin child issue",
      status: "todo",
      assigneeAgentId: agentId,
      billingCode: "mission:alpha",
      originId: "mission-alpha",
      blockedByIssueIds: [blockerIssueId],
      actorAgentId: agentId,
      actorRunId: originRunId,
    });

    const [stored] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(stored?.originKind).toBe("plugin:paperclip.missions");
    expect(stored?.originId).toBe("mission-alpha");
    expect(stored?.billingCode).toBe("mission:alpha");
    expect(stored?.assigneeAgentId).toBe(agentId);
    expect(stored?.createdByAgentId).toBe(agentId);
    expect(stored?.originRunId).toBe(originRunId);

    const [relation] = await db
      .select()
      .from(issueRelations)
      .where(and(eq(issueRelations.issueId, blockerIssueId), eq(issueRelations.relatedIssueId, issue.id)));
    expect(relation?.type).toBe("blocks");

    const activities = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityType, "issue"), eq(activityLog.entityId, issue.id)));
    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorType: "plugin",
          actorId: "plugin-record-id",
          action: "issue.created",
          agentId,
          details: expect.objectContaining({
            sourcePluginId: "plugin-record-id",
            sourcePluginKey: "paperclip.missions",
            initiatingActorType: "agent",
            initiatingActorId: agentId,
            initiatingRunId: originRunId,
          }),
        }),
      ]),
    );
  });

  it("routes plugin completion through the assigned agent's automatic reviewer", async () => {
    const { companyId, agentId: workerId } = await seedCompanyAndAgent();
    const reviewerId = randomUUID();
    await db.insert(agents).values({
      id: reviewerId,
      companyId,
      name: "Reviewer",
      role: "engineer",
      status: "paused",
      adapterType: "process",
      adapterConfig: { command: "true" },
      runtimeConfig: {},
      permissions: {},
    });
    await db.update(agents)
      .set({ defaultReviewerAgentId: reviewerId })
      .where(eq(agents.id, workerId));

    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());
    const issue = await services.issues.create({
      companyId,
      title: "Plugin reviewed issue",
      status: "in_progress",
      assigneeAgentId: workerId,
      actorAgentId: workerId,
    });

    const updated = await services.issues.update({
      issueId: issue.id,
      companyId,
      patch: { status: "done", actorAgentId: workerId },
    });

    expect(updated.status).toBe("in_review");
    expect(updated.assigneeAgentId).toBe(reviewerId);
    expect(updated.executionState).toMatchObject({
      status: "pending",
      currentParticipant: { type: "agent", agentId: reviewerId },
      returnAssignee: { type: "agent", agentId: workerId },
    });
  });

  it("keeps the worker's policy when plugin completion names its configured reviewer", async () => {
    const { companyId, agentId: workerId } = await seedCompanyAndAgent();
    const reviewerId = randomUUID();
    await db.insert(agents).values({
      id: reviewerId,
      companyId,
      name: "Reviewer",
      role: "engineer",
      status: "paused",
      adapterType: "process",
      adapterConfig: { command: "true" },
      runtimeConfig: {},
      permissions: {},
    });
    await db.update(agents)
      .set({ defaultReviewerAgentId: reviewerId })
      .where(eq(agents.id, workerId));

    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());
    const issue = await services.issues.create({
      companyId,
      title: "Plugin explicit reviewer handoff",
      status: "in_progress",
      assigneeAgentId: workerId,
      actorAgentId: workerId,
    });

    const updated = await services.issues.update({
      issueId: issue.id,
      companyId,
      patch: { status: "done", assigneeAgentId: reviewerId },
    });

    expect(updated.status).toBe("in_review");
    expect(updated.assigneeAgentId).toBe(reviewerId);
    expect(updated.executionPolicy).toEqual(issue.executionPolicy);
    expect(updated.executionState).toMatchObject({
      status: "pending",
      currentParticipant: { type: "agent", agentId: reviewerId },
      returnAssignee: { type: "agent", agentId: workerId },
    });
  });

  it("stores the same normalized policy IDs used by plugin review state", async () => {
    const { companyId, agentId: workerId } = await seedCompanyAndAgent();
    const reviewerId = randomUUID();
    await db.insert(agents).values({
      id: reviewerId,
      companyId,
      name: "Reviewer",
      role: "engineer",
      status: "paused",
      adapterType: "process",
      adapterConfig: { command: "true" },
      runtimeConfig: {},
      permissions: {},
    });
    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());
    const issue = await services.issues.create({
      companyId,
      title: "Plugin explicit policy",
      status: "in_progress",
      assigneeAgentId: workerId,
      actorAgentId: workerId,
    });

    const updated = await services.issues.update({
      issueId: issue.id,
      companyId,
      patch: {
        status: "done",
        executionPolicy: {
          stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewerId }] }],
        },
      },
    });

    expect(updated.status).toBe("in_review");
    expect(updated.executionState).toMatchObject({
      currentStageId: updated.executionPolicy?.stages[0]?.id,
      currentParticipant: { type: "agent", agentId: reviewerId },
    });
  });

  it("records a plugin review decision and its required comment atomically", async () => {
    const { companyId, agentId: workerId } = await seedCompanyAndAgent();
    const reviewerId = randomUUID();
    await db.insert(agents).values({
      id: reviewerId,
      companyId,
      name: "Reviewer",
      role: "engineer",
      status: "paused",
      adapterType: "process",
      adapterConfig: { command: "true" },
      runtimeConfig: {},
      permissions: {},
    });
    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());
    const issue = await services.issues.create({
      companyId,
      title: "Plugin review decision",
      status: "in_progress",
      assigneeAgentId: workerId,
      actorAgentId: workerId,
    });
    const inReview = await services.issues.update({
      issueId: issue.id,
      companyId,
      patch: {
        status: "done",
        executionPolicy: {
          stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewerId }] }],
        },
        actorAgentId: workerId,
      },
    });

    const approved = await services.issues.update({
      issueId: issue.id,
      companyId,
      patch: {
        status: "done",
        comment: "Approved after checking the acceptance criteria.",
        actorAgentId: reviewerId,
      },
    });

    expect(inReview.status).toBe("in_review");
    expect(approved.status).toBe("done");
    const [decisionRows, commentRows] = await Promise.all([
      db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, issue.id)),
      db.select().from(issueComments).where(eq(issueComments.issueId, issue.id)),
    ]);
    expect(decisionRows).toHaveLength(1);
    expect(decisionRows[0]).toMatchObject({
      actorAgentId: reviewerId,
      outcome: "approved",
      body: "Approved after checking the acceptance criteria.",
    });
    expect(commentRows).toHaveLength(1);
    expect(commentRows[0]).toMatchObject({
      authorAgentId: reviewerId,
      body: "Approved after checking the acceptance criteria.",
    });
  });

  it("rejects an unavailable requested worker before a plugin reviewer handoff", async () => {
    const { companyId, agentId: workerId } = await seedCompanyAndAgent();
    const reviewerId = randomUUID();
    const terminatedWorkerId = randomUUID();
    await db.insert(agents).values([
      {
        id: reviewerId,
        companyId,
        name: "Reviewer",
        role: "engineer",
        status: "paused",
        adapterType: "process",
        adapterConfig: { command: "true" },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: terminatedWorkerId,
        companyId,
        name: "Terminated worker",
        role: "engineer",
        status: "terminated",
        adapterType: "process",
        adapterConfig: { command: "true" },
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());
    const issue = await services.issues.create({
      companyId,
      title: "Reject plugin return worker",
      status: "in_progress",
      assigneeAgentId: workerId,
      actorAgentId: workerId,
    });

    await expect(services.issues.update({
      issueId: issue.id,
      companyId,
      patch: {
        status: "done",
        assigneeAgentId: terminatedWorkerId,
        executionPolicy: {
          stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewerId }] }],
        },
        actorAgentId: workerId,
      },
    })).rejects.toThrow("Cannot assign work to terminated agents");
  });

  it("clears a stale review handoff when a plugin reassigns work", async () => {
    const { companyId, agentId: firstWorkerId } = await seedCompanyAndAgent();
    const firstReviewerId = randomUUID();
    const nextWorkerId = randomUUID();
    const nextReviewerId = randomUUID();
    await db.insert(agents).values([
      {
        id: firstReviewerId,
        companyId,
        name: "First Reviewer",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: { command: "true" },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: nextReviewerId,
        companyId,
        name: "Next Reviewer",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: { command: "true" },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: nextWorkerId,
        companyId,
        name: "Next Worker",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: { command: "true" },
        runtimeConfig: {},
        permissions: {},
        defaultReviewerAgentId: nextReviewerId,
      },
    ]);
    await db.update(agents)
      .set({ defaultReviewerAgentId: firstReviewerId })
      .where(eq(agents.id, firstWorkerId));
    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());
    const inReview = await services.issues.create({
      companyId,
      title: "Plugin reassignment",
      status: "done",
      assigneeAgentId: firstWorkerId,
      actorAgentId: firstWorkerId,
    });
    expect(inReview.status).toBe("in_review");

    const reassigned = await services.issues.update({
      issueId: inReview.id,
      companyId,
      patch: { assigneeAgentId: nextWorkerId },
    });

    expect(reassigned.status).toBe("in_progress");
    expect(reassigned.assigneeAgentId).toBe(nextWorkerId);
    expect(reassigned.executionState).toBeNull();
    expect(reassigned.executionPolicy).toMatchObject({
      stages: [{ participants: [{ type: "agent", agentId: nextReviewerId }] }],
    });
  });

  it("enforces plugin origin namespaces", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());

    const featureIssue = await services.issues.create({
      companyId,
      title: "Feature issue",
      originKind: "plugin:paperclip.missions:feature",
      originId: "mission-alpha:feature-1",
    });
    expect(featureIssue.originKind).toBe("plugin:paperclip.missions:feature");

    await expect(
      services.issues.create({
        companyId,
        title: "Spoofed issue",
        originKind: "plugin:other.plugin:feature",
      }),
    ).rejects.toThrow("Plugin may only use originKind values under plugin:paperclip.missions");

    await expect(
      services.issues.update({
        issueId: featureIssue.id,
        companyId,
        patch: { originKind: "plugin:other.plugin:feature" },
      }),
    ).rejects.toThrow("Plugin may only use originKind values under plugin:paperclip.missions");
  });

  it("asserts checkout ownership for run-scoped plugin actions", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Checked out issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
    });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());
    await expect(
      services.issues.assertCheckoutOwner({
        issueId,
        companyId,
        actorAgentId: agentId,
        actorRunId: runId,
      }),
    ).resolves.toMatchObject({
      issueId,
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
    });
  });

  it("refuses plugin wakeups for issues with unresolved blockers", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const blockerIssueId = randomUUID();
    const blockedIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: blockerIssueId,
        companyId,
        title: "Unresolved blocker",
        status: "todo",
        priority: "medium",
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());
    await expect(
      services.issues.requestWakeup({
        issueId: blockedIssueId,
        companyId,
        reason: "mission_advance",
      }),
    ).rejects.toThrow("Issue is blocked by unresolved blockers");
  });

  it("narrows orchestration cost summaries by subtree and billing code", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();
    const unrelatedIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        title: "Root mission",
        status: "todo",
        priority: "medium",
        billingCode: "mission:alpha",
      },
      {
        id: childIssueId,
        companyId,
        parentId: rootIssueId,
        title: "Child mission",
        status: "todo",
        priority: "medium",
        billingCode: "mission:alpha",
      },
      {
        id: unrelatedIssueId,
        companyId,
        title: "Different mission",
        status: "todo",
        priority: "medium",
        billingCode: "mission:alpha",
      },
    ]);
    await db.insert(costEvents).values([
      {
        companyId,
        agentId,
        issueId: rootIssueId,
        billingCode: "mission:alpha",
        provider: "test",
        model: "unit",
        inputTokens: 10,
        cachedInputTokens: 1,
        outputTokens: 2,
        costCents: 100,
        occurredAt: new Date(),
      },
      {
        companyId,
        agentId,
        issueId: childIssueId,
        billingCode: "mission:alpha",
        provider: "test",
        model: "unit",
        inputTokens: 20,
        cachedInputTokens: 2,
        outputTokens: 4,
        costCents: 200,
        occurredAt: new Date(),
      },
      {
        companyId,
        agentId,
        issueId: childIssueId,
        billingCode: "mission:beta",
        provider: "test",
        model: "unit",
        inputTokens: 30,
        cachedInputTokens: 3,
        outputTokens: 6,
        costCents: 300,
        occurredAt: new Date(),
      },
      {
        companyId,
        agentId,
        issueId: unrelatedIssueId,
        billingCode: "mission:alpha",
        provider: "test",
        model: "unit",
        inputTokens: 40,
        cachedInputTokens: 4,
        outputTokens: 8,
        costCents: 400,
        occurredAt: new Date(),
      },
    ]);

    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());
    const summary = await services.issues.getOrchestrationSummary({
      companyId,
      issueId: rootIssueId,
      includeSubtree: true,
    });

    expect(new Set(summary.subtreeIssueIds)).toEqual(new Set([rootIssueId, childIssueId]));
    expect(summary.costs).toMatchObject({
      billingCode: "mission:alpha",
      costCents: 300,
      inputTokens: 30,
      cachedInputTokens: 3,
      outputTokens: 6,
    });
  });
});
