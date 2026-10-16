import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { conflict } from "../errors.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  defaultExecutionPolicyForAssignee: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  addCommentIdempotent: vi.fn(),
  addCorrectionIdempotent: vi.fn(),
  getCommentByIdempotencyKey: vi.fn(),
  getDependencyReadiness: vi.fn(),
  findMentionedAgents: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  getMembership: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatState = vi.hoisted(() => ({
  acceptedDeliveryKeys: new Set<string>(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async (agentId: string, options?: { idempotencyKey?: string }) => {
    if (options?.idempotencyKey) mockHeartbeatState.acceptedDeliveryKeys.add(`${agentId}:${options.idempotencyKey}`);
  }),
  getWakeupDelivery: vi.fn(async (agentId: string, idempotencyKey: string) => ({
    status: mockHeartbeatState.acceptedDeliveryKeys.has(`${agentId}:${idempotencyKey}`)
      ? "accepted" as const
      : "pending" as const,
    reason: undefined as string | undefined,
  })),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockSyncComment = vi.hoisted(() => vi.fn(async () => undefined));
const mockTxInsertValues = vi.hoisted(() => vi.fn(async () => undefined));
const mockTxInsert = vi.hoisted(() => vi.fn(() => ({ values: mockTxInsertValues })));
const mockTx = vi.hoisted(() => ({
  insert: mockTxInsert,
}));
const mockDb = vi.hoisted(() => ({
  transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    id: "instance-settings-1",
    general: {
      censorUsernameInLogs: false,
    },
  })),
  listCompanyIds: vi.fn(async () => ["company-1"]),
}));
const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(async () => undefined),
}));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));
const mockIssueTreeControlService = vi.hoisted(() => ({
  getActivePauseHoldGate: vi.fn(async () => null),
}));

vi.mock("../services/access.js", () => ({
  accessService: () => mockAccessService,
}));

vi.mock("../services/activity-log.js", () => ({
  deterministicActivityId: (...parts: string[]) => `activity:${parts.join(":")}`,
  logActivity: mockLogActivity,
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => mockHeartbeatService,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));

vi.mock("../services/routines.js", () => ({
  routineService: () => mockRoutineService,
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
  issueApprovalService: () => ({}),
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: mockSyncComment,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueService: () => mockIssueService,
  issueThreadInteractionService: () => mockIssueThreadInteractionService,
  issueTreeControlService: () => mockIssueTreeControlService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => mockRoutineService,
  workProductService: () => ({}),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  return app;
}

async function installActor(app: express.Express, actor?: Record<string, unknown>) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/issues.js"),
    import("../middleware/index.js"),
  ]);
  app.use((req, _res, next) => {
    (req as any).actor = actor ?? {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

async function normalizePolicy(input: {
  stages: Array<{
    id: string;
    type: "review" | "approval";
    participants: Array<{ type: "agent"; agentId: string } | { type: "user"; userId: string }>;
  }>;
}) {
  const { normalizeIssueExecutionPolicy } = await import("../services/issue-execution-policy.js");
  return normalizeIssueExecutionPolicy(input);
}

function makeIssue(status: "todo" | "done" | "blocked" | "cancelled" | "in_progress") {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    status,
    assigneeAgentId: "22222222-2222-4222-8222-222222222222",
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-580",
    title: "Comment reopen default",
  };
}

function agentActor(agentId = "22222222-2222-4222-8222-222222222222") {
  return {
    type: "agent",
    agentId,
    companyId: "company-1",
    source: "agent_key",
    runId: "run-1",
  };
}

function toolSessionActor() {
  return {
    type: "tool_session",
    userId: "tool-user",
    companyId: "company-1",
    companyIds: ["company-1"],
    source: "tool_session",
    isInstanceAdmin: false,
    person: {
      type: "board",
      userId: "tool-user",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active" }],
      source: "session",
      isInstanceAdmin: false,
    },
  };
}

async function waitForWakeup(assertion: () => void) {
  await vi.waitFor(assertion);
}

describe.sequential("issue comment reopen routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockReset();
    mockIssueService.defaultExecutionPolicyForAssignee.mockReset();
    mockIssueService.assertCheckoutOwner.mockReset();
    mockIssueService.update.mockReset();
    mockIssueService.addComment.mockReset();
    mockIssueService.addCommentIdempotent.mockReset();
    mockIssueService.addCorrectionIdempotent.mockReset();
    mockIssueService.getCommentByIdempotencyKey.mockResolvedValue(null);
    mockIssueService.getDependencyReadiness.mockReset();
    mockIssueService.findMentionedAgents.mockReset();
    mockIssueService.listWakeableBlockedDependents.mockReset();
    mockIssueService.getWakeableParentAfterChildCompletion.mockReset();
    mockSyncComment.mockReset();
    mockAccessService.canUser.mockReset();
    mockAccessService.getMembership.mockReset();
    mockAccessService.hasPermission.mockReset();
    mockAccessService.getMembership.mockReset();
    mockHeartbeatService.wakeup.mockReset();
    mockHeartbeatService.getWakeupDelivery.mockReset();
    mockHeartbeatService.reportRunActivity.mockReset();
    mockHeartbeatService.getRun.mockReset();
    mockHeartbeatService.getActiveRunForAgent.mockReset();
    mockHeartbeatService.cancelRun.mockReset();
    mockAgentService.getById.mockReset();
    mockAgentService.list.mockReset();
    mockAgentService.resolveByReference.mockReset();
    mockLogActivity.mockReset();
    mockInstanceSettingsService.get.mockReset();
    mockInstanceSettingsService.listCompanyIds.mockReset();
    mockRoutineService.syncRunStatusForIssue.mockReset();
    mockIssueTreeControlService.getActivePauseHoldGate.mockReset();
    mockTxInsertValues.mockReset();
    mockTxInsert.mockReset();
    mockDb.transaction.mockReset();
    mockTxInsertValues.mockResolvedValue(undefined);
    mockTxInsert.mockImplementation(() => ({ values: mockTxInsertValues }));
    mockDb.transaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx));
    mockIssueService.defaultExecutionPolicyForAssignee.mockResolvedValue(null);
    mockAccessService.getMembership.mockResolvedValue({ status: "active" });
    mockHeartbeatState.acceptedDeliveryKeys.clear();
    mockHeartbeatService.wakeup.mockImplementation(async (agentId: string, options?: { idempotencyKey?: string }) => {
      if (options?.idempotencyKey) mockHeartbeatState.acceptedDeliveryKeys.add(`${agentId}:${options.idempotencyKey}`);
    });
    mockHeartbeatService.getWakeupDelivery.mockImplementation(async (agentId: string, idempotencyKey: string) => ({
      status: mockHeartbeatState.acceptedDeliveryKeys.has(`${agentId}:${idempotencyKey}`) ? "accepted" : "pending",
      reason: undefined,
    }));
    mockHeartbeatService.reportRunActivity.mockResolvedValue(undefined);
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockHeartbeatService.cancelRun.mockResolvedValue(null);
    mockLogActivity.mockResolvedValue(undefined);
    mockInstanceSettingsService.get.mockResolvedValue({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
      },
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);
    mockRoutineService.syncRunStatusForIssue.mockResolvedValue(undefined);
    mockIssueTreeControlService.getActivePauseHoldGate.mockResolvedValue(null);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      body: "hello",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: null,
      authorUserId: "local-board",
    });
    mockIssueService.defaultExecutionPolicyForAssignee.mockResolvedValue(null);
    mockIssueService.addCommentIdempotent.mockResolvedValue({
      created: true,
      comment: {
        id: "comment-idempotent-1",
        issueId: "11111111-1111-4111-8111-111111111111",
        companyId: "company-1",
        body: "hello",
        intent: "message",
        idempotencyKey: "ollama.mixed:v1_test",
        createdAt: new Date(),
        updatedAt: new Date(),
        authorAgentId: "22222222-2222-4222-8222-222222222222",
        authorUserId: null,
      },
    });
    mockIssueService.addCorrectionIdempotent.mockResolvedValue({
      created: true,
      previousStatus: "done",
      assigneeChanged: true,
      issue: {
        ...makeIssue("todo"),
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      },
      comment: {
        id: "comment-correction-reassign",
        issueId: "11111111-1111-4111-8111-111111111111",
        companyId: "company-1",
        body: "Check the source.",
        intent: "correction",
        expectedAssigneeAgentId: "33333333-3333-4333-8333-333333333333",
        authorAgentId: null,
        authorUserId: "local-board",
      },
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: "11111111-1111-4111-8111-111111111111",
      blockerIssueIds: [],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      allBlockersDone: true,
      isDependencyReady: true,
    });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.getMembership.mockResolvedValue({ status: "active" });
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAgentService.getById.mockResolvedValue(null);
    mockAgentService.list.mockResolvedValue([
      {
        id: "22222222-2222-4222-8222-222222222222",
        reportsTo: null,
        permissions: { canCreateAgents: false },
      },
      {
        id: "44444444-4444-4444-8444-444444444444",
        reportsTo: null,
        permissions: { canCreateAgents: false },
      },
    ]);
    mockAgentService.resolveByReference.mockImplementation(async (_companyId: string, reference: string) => {
      if (reference === "ambiguous-codex") {
        return { ambiguous: true, agent: null };
      }
      if (reference === "missing-codex") {
        return { ambiguous: false, agent: null };
      }
      if (reference === "codexcoder") {
        return {
          ambiguous: false,
          agent: { id: "33333333-3333-4333-8333-333333333333" },
        };
      }
      return {
        ambiguous: false,
        agent: { id: reference },
      };
    });
  });

  it("treats reopen=true as a no-op when the issue is already open", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("todo"),
      ...patch,
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello", reopen: true, assigneeAgentId: "33333333-3333-4333-8333-333333333333" });

    expect(res.status).toBe(200);
    expect(res.body.assigneeAgentId).toBe("33333333-3333-4333-8333-333333333333");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.not.objectContaining({ reopened: true }),
      }),
    );
  });

  it("rejects correction intent on PATCH and directs callers to the comment endpoint", async () => {
    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "Please correct the earlier run", commentIntent: "correction" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Correction comments must be submitted with POST /issues/:id/comments",
    });
    expect(mockIssueService.getById).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("records board correction intent and wakes the assigned agent", async () => {
    const issue = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.addCorrectionIdempotent.mockResolvedValue({
      created: true,
      previousStatus: null,
      assigneeChanged: false,
      issue,
      comment: {
        id: "comment-current-correction",
        issueId: issue.id,
        companyId: issue.companyId,
        body: "Always verify the total first.",
        intent: "correction",
        expectedAssigneeAgentId: issue.assigneeAgentId,
        authorAgentId: null,
        authorUserId: "local-board",
      },
    });
    const res = await request(await installActor(createApp()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "Always verify the total first.", intent: "correction", idempotencyKey: "board.correction:v1_total" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.addCorrectionIdempotent).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "Always verify the total first.",
      expect.objectContaining({
        reopen: true,
        targetAgentId: issue.assigneeAgentId,
        correctionRecipientAgentIds: [issue.assigneeAgentId],
        userId: "local-board",
        idempotencyKey: "board.correction:v1_total",
      }),
    );
    expect(mockIssueService.addCommentIdempotent).not.toHaveBeenCalled();
    expect(mockIssueService.addCorrectionIdempotent.mock.invocationCallOrder[0]).toBeLessThan(
      Math.min(
        mockSyncComment.mock.invocationCallOrder[0],
        mockLogActivity.mock.invocationCallOrder[0],
        mockHeartbeatService.wakeup.mock.invocationCallOrder[0],
      ),
    );
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({ reason: "issue_commented" }),
    ));
  });

  it("fails before saving a correction when mention resolution fails and creates it on retry", async () => {
    const issue = makeIssue("in_progress");
    const mentionedAgentId = "44444444-4444-4444-8444-444444444444";
    const comment = {
      id: "comment-mention-retry",
      issueId: issue.id,
      companyId: issue.companyId,
      body: "Check with @reviewer before finalizing.",
      intent: "correction",
      idempotencyKey: "board.correction:v1_mention-retry",
      expectedAssigneeAgentId: issue.assigneeAgentId,
      authorAgentId: null,
      authorUserId: "local-board",
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.addCorrectionIdempotent
      .mockResolvedValueOnce({ comment, created: true, previousStatus: null, assigneeChanged: false, issue });
    mockIssueService.findMentionedAgents
      .mockRejectedValueOnce(new Error("Mention lookup unavailable"))
      .mockResolvedValueOnce([mentionedAgentId]);
    const payload = { body: comment.body, intent: "correction", idempotencyKey: comment.idempotencyKey };
    const app = await installActor(createApp());

    const first = await request(app).post(`/api/issues/${issue.id}/comments`).send(payload);
    expect(first.status).toBe(500);
    expect(mockIssueService.addCorrectionIdempotent).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();

    const retry = await request(app).post(`/api/issues/${issue.id}/comments`).send(payload);
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    expect(mockIssueService.addCorrectionIdempotent).toHaveBeenCalledWith(issue.id, comment.body, expect.objectContaining({
      correctionRecipientAgentIds: [issue.assigneeAgentId, mentionedAgentId].sort(),
    }));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(2);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(issue.assigneeAgentId, expect.objectContaining({
      idempotencyKey: `issue-comment:${comment.id}:assignee:${issue.assigneeAgentId}`,
    }));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(mentionedAgentId, expect.objectContaining({
      idempotencyKey: `issue-comment:${comment.id}:mention:${mentionedAgentId}`,
    }));
  });

  it("fails before atomically reopening when mention resolution fails and succeeds on retry", async () => {
    const issue = makeIssue("done");
    const resultIssue = { ...issue, status: "todo" as const };
    const comment = {
      id: "comment-reopened-mention-retry",
      issueId: issue.id,
      companyId: issue.companyId,
      body: "Check with @reviewer before finalizing.",
      intent: "correction",
      idempotencyKey: "board.correction:v1_reopened-mention-retry",
      expectedAssigneeAgentId: issue.assigneeAgentId,
      authorAgentId: null,
      authorUserId: "local-board",
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.addCorrectionIdempotent
      .mockResolvedValueOnce({ comment, created: true, previousStatus: "done", assigneeChanged: false, issue: resultIssue });
    mockIssueService.findMentionedAgents
      .mockRejectedValueOnce(new Error("Mention lookup unavailable"))
      .mockResolvedValueOnce([]);
    const payload = { body: comment.body, intent: "correction", idempotencyKey: comment.idempotencyKey };
    const app = await installActor(createApp());

    const first = await request(app).post(`/api/issues/${issue.id}/comments`).send(payload);
    expect(first.status).toBe(500);
    expect(mockIssueService.addCorrectionIdempotent).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();

    const retry = await request(app).post(`/api/issues/${issue.id}/comments`).send(payload);
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledExactlyOnceWith(issue.assigneeAgentId, expect.objectContaining({
      idempotencyKey: `issue-comment:${comment.id}:assignee:${issue.assigneeAgentId}`,
    }));
  });

  it("fails a prior-assignee correction before the ordinary comment transaction when mention resolution fails", async () => {
    const issue = makeIssue("done");
    const priorAgentId = "33333333-3333-4333-8333-333333333333";
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.findMentionedAgents.mockRejectedValue(new Error("Mention lookup unavailable"));

    const response = await request(await installActor(createApp()))
      .post(`/api/issues/${issue.id}/comments`)
      .send({
        body: "Ask @reviewer to check the prior result.",
        intent: "correction",
        idempotencyKey: "board.correction:v1_prior-resolution-failure",
        expectedAssigneeAgentId: priorAgentId,
        allowPriorAssigneeTarget: true,
      });

    expect(response.status).toBe(500);
    expect(mockIssueService.addCommentIdempotent).not.toHaveBeenCalled();
    expect(mockSyncComment).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("retries an immutable correction mention recipient after the agent is renamed", async () => {
    const issue = makeIssue("in_progress");
    const mentionedAgentId = "44444444-4444-4444-8444-444444444444";
    const reusedNameAgentId = "55555555-5555-4555-8555-555555555555";
    const comment = {
      id: "comment-renamed-mention",
      issueId: issue.id,
      companyId: issue.companyId,
      body: "Ask @reviewer to verify this.",
      intent: "correction",
      idempotencyKey: "board.correction:v1_renamed-mention",
      expectedAssigneeAgentId: issue.assigneeAgentId,
      authorAgentId: null,
      authorUserId: "local-board",
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.addCorrectionIdempotent
      .mockResolvedValueOnce({ comment, created: true, previousStatus: null, assigneeChanged: false, issue })
      .mockResolvedValueOnce({
        comment: { ...comment, correctionRecipientAgentIds: [issue.assigneeAgentId, mentionedAgentId] },
        created: false,
        previousStatus: null,
        assigneeChanged: false,
        issue,
      });
    mockIssueService.getCommentByIdempotencyKey
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ ...comment, correctionRecipientAgentIds: [issue.assigneeAgentId, mentionedAgentId] });
    mockIssueService.findMentionedAgents
      .mockResolvedValueOnce([mentionedAgentId])
      .mockResolvedValueOnce([reusedNameAgentId]);
    let mentionAttempts = 0;
    mockHeartbeatService.wakeup.mockImplementation(async (agentId: string, options?: { idempotencyKey?: string }) => {
      if (agentId === mentionedAgentId && ++mentionAttempts === 1) return;
      if (options?.idempotencyKey) mockHeartbeatState.acceptedDeliveryKeys.add(`${agentId}:${options.idempotencyKey}`);
    });
    const payload = { body: comment.body, intent: "correction", idempotencyKey: comment.idempotencyKey };
    const app = await installActor(createApp());

    const first = await request(app).post(`/api/issues/${issue.id}/comments`).send(payload);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.correctionDelivery).toMatchObject({
      status: "pending",
      pending: [{ agentId: mentionedAgentId }],
    });

    const retry = await request(app).post(`/api/issues/${issue.id}/comments`).send(payload);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.correctionDelivery).toEqual({ status: "accepted", pending: [] });
    expect(mockIssueService.addCorrectionIdempotent).toHaveBeenNthCalledWith(1, issue.id, comment.body, expect.objectContaining({
      correctionRecipientAgentIds: [issue.assigneeAgentId, mentionedAgentId].sort(),
    }));
    expect(mockIssueService.addCorrectionIdempotent).toHaveBeenNthCalledWith(2, issue.id, comment.body, expect.objectContaining({
      correctionRecipientAgentIds: [issue.assigneeAgentId, mentionedAgentId],
    }));
    expect(mockHeartbeatService.wakeup.mock.calls.filter(([agentId]) => agentId === mentionedAgentId)).toHaveLength(2);
    expect(mockHeartbeatService.wakeup.mock.calls.some(([agentId]) => agentId === reusedNameAgentId)).toBe(false);
    expect(mockIssueService.findMentionedAgents).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenLastCalledWith(mentionedAgentId, expect.objectContaining({
      idempotencyKey: `issue-comment:${comment.id}:mention:${mentionedAgentId}`,
      reason: "issue_comment_mentioned",
    }));
  });

  it("retries the complete original recipient set after a partial correction wake", async () => {
    const issue = makeIssue("in_progress");
    const firstMentionId = "44444444-4444-4444-8444-444444444444";
    const missingReceiptMentionId = "55555555-5555-4555-8555-555555555555";
    const fullRecipientSet = [issue.assigneeAgentId, firstMentionId, missingReceiptMentionId].sort();
    const comment = {
      id: "comment-partial-wake",
      issueId: issue.id,
      companyId: issue.companyId,
      body: "Ask @first and @second to verify this.",
      intent: "correction",
      idempotencyKey: "board.correction:v1_partial-wake",
      expectedAssigneeAgentId: issue.assigneeAgentId,
      authorAgentId: null,
      authorUserId: "local-board",
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.addCorrectionIdempotent
      .mockResolvedValueOnce({ comment, created: true, previousStatus: null, assigneeChanged: false, issue })
      .mockResolvedValueOnce({
        comment: { ...comment, correctionRecipientAgentIds: fullRecipientSet },
        created: false,
        previousStatus: null,
        assigneeChanged: false,
        issue,
      });
    mockIssueService.getCommentByIdempotencyKey
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ ...comment, correctionRecipientAgentIds: fullRecipientSet });
    mockIssueService.findMentionedAgents.mockResolvedValueOnce([firstMentionId, missingReceiptMentionId]);
    let missingReceiptAttempts = 0;
    mockHeartbeatService.wakeup.mockImplementation(async (agentId: string, options?: { idempotencyKey?: string }) => {
      if (agentId === missingReceiptMentionId && ++missingReceiptAttempts === 1) {
        throw new Error("Wake storage unavailable");
      }
      if (options?.idempotencyKey) mockHeartbeatState.acceptedDeliveryKeys.add(`${agentId}:${options.idempotencyKey}`);
    });
    const payload = { body: comment.body, intent: "correction", idempotencyKey: comment.idempotencyKey };
    const app = await installActor(createApp());

    const first = await request(app).post(`/api/issues/${issue.id}/comments`).send(payload);
    expect(first.status).toBe(500);
    const retry = await request(app).post(`/api/issues/${issue.id}/comments`).send(payload);

    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.correctionDelivery).toEqual({ status: "accepted", pending: [] });
    expect(mockIssueService.findMentionedAgents).toHaveBeenCalledTimes(1);
    expect(mockIssueService.addCorrectionIdempotent.mock.invocationCallOrder[0]).toBeLessThan(
      Math.min(...mockHeartbeatService.wakeup.mock.invocationCallOrder),
    );
    expect(mockHeartbeatService.wakeup.mock.calls.filter(([agentId]) => agentId === issue.assigneeAgentId)).toHaveLength(1);
    expect(mockHeartbeatService.wakeup.mock.calls.filter(([agentId]) => agentId === firstMentionId)).toHaveLength(1);
    expect(mockHeartbeatService.wakeup.mock.calls.filter(([agentId]) => agentId === missingReceiptMentionId)).toHaveLength(2);
    expect(mockHeartbeatService.wakeup).toHaveBeenLastCalledWith(missingReceiptMentionId, expect.objectContaining({
      idempotencyKey: `issue-comment:${comment.id}:mention:${missingReceiptMentionId}`,
    }));
  });

  it("keeps ordinary comment mention resolution best effort", async () => {
    const issue = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.findMentionedAgents.mockRejectedValue(new Error("Mention lookup unavailable"));

    const response = await request(await installActor(createApp()))
      .post(`/api/issues/${issue.id}/comments`)
      .send({ body: "Please ask @reviewer.", idempotencyKey: "board.message:v1_mention-best-effort" });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      issue.assigneeAgentId,
      expect.objectContaining({ reason: "issue_commented" }),
    ));
  });

  it("passes the expected assignee through the atomic correction insert", async () => {
    const expectedAssigneeAgentId = "22222222-2222-4222-8222-222222222222";
    mockIssueService.getById.mockResolvedValue(makeIssue("in_progress"));
    const res = await request(await installActor(createApp()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({
        body: "Always verify the total first.",
        intent: "correction",
        expectedAssigneeAgentId,
        idempotencyKey: "board.correction:v1_expected",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.addCorrectionIdempotent).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "Always verify the total first.",
      expect.objectContaining({ targetAgentId: expectedAssigneeAgentId, reopen: true, idempotencyKey: "board.correction:v1_expected" }),
    );
  });

  it("returns the atomic assignee conflict without activity or wakeups", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("in_progress"));
    mockIssueService.addCorrectionIdempotent.mockRejectedValue(
      conflict("The correction is no longer assigned to the expected agent"),
    );
    const res = await request(await installActor(createApp()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({
        body: "Always verify the total first.",
        intent: "correction",
        expectedAssigneeAgentId: "22222222-2222-4222-8222-222222222222",
        idempotencyKey: "board.correction:v1_conflict",
      });

    expect(res.status).toBe(409);
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("does not let an agent mark its own comment as a correction", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("in_progress"));
    const res = await request(await installActor(createApp(), agentActor()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "I changed my own rules.", intent: "correction", idempotencyKey: "board.correction:v1_agent" });
    expect(res.status).toBe(403);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("lets a user-driven tool session mark a correction", async () => {
    const issue = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.addCorrectionIdempotent.mockResolvedValue({
      created: true,
      previousStatus: null,
      assigneeChanged: false,
      issue,
      comment: {
        id: "comment-tool-correction",
        issueId: issue.id,
        companyId: issue.companyId,
        body: "Always verify the source first.",
        intent: "correction",
        expectedAssigneeAgentId: issue.assigneeAgentId,
        authorAgentId: null,
        authorUserId: "tool-user",
      },
    });
    const res = await request(await installActor(createApp(), toolSessionActor()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "Always verify the source first.", intent: "correction", idempotencyKey: "board.correction:v1_tool" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.addCorrectionIdempotent).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "Always verify the source first.",
      expect.objectContaining({ targetAgentId: issue.assigneeAgentId, reopen: true, userId: "tool-user", idempotencyKey: "board.correction:v1_tool" }),
    );
  });

  it("returns an existing idempotent agent comment without duplicate activity or wakeups", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("in_progress"));
    const existing = {
      id: "comment-existing",
      issueId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      body: "The ordinary answer.",
      intent: "message",
      idempotencyKey: "ollama.mixed:v1_retry",
      authorAgentId: "22222222-2222-4222-8222-222222222222",
      authorUserId: null,
    };
    mockIssueService.addCommentIdempotent.mockResolvedValue({ comment: existing, created: false });

    const res = await request(await installActor(createApp(), agentActor()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "A regenerated answer.", idempotencyKey: "ollama.mixed:v1_retry" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(existing);
    expect(mockIssueService.addCommentIdempotent).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "A regenerated answer.",
      expect.objectContaining({
        idempotencyKey: "ollama.mixed:v1_retry",
        agentId: "22222222-2222-4222-8222-222222222222",
      }),
    );
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("resumes durable correction side effects when an exact retry arrives after reassignment", async () => {
    const expectedAssigneeAgentId = "22222222-2222-4222-8222-222222222222";
    mockIssueService.getById.mockResolvedValue({ ...makeIssue("in_progress"), assigneeAgentId: null });
    const existing = {
      id: "comment-existing-correction",
      issueId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      body: "Always verify the source first.",
      intent: "correction",
      idempotencyKey: "handoff.review:production-run",
      expectedAssigneeAgentId,
      authorAgentId: null,
      authorUserId: "tool-user",
    };
    mockIssueService.addCommentIdempotent.mockResolvedValue({ comment: existing, created: false });

    const res = await request(await installActor(createApp()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({
        body: existing.body,
        intent: "correction",
        idempotencyKey: existing.idempotencyKey,
        expectedAssigneeAgentId,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockSyncComment).toHaveBeenCalledWith(existing.id);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "issue.comment_added",
      details: expect.objectContaining({ commentId: existing.id }),
    }));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      expectedAssigneeAgentId,
      expect.objectContaining({
        idempotencyKey: `issue-comment:${existing.id}:assignee:${expectedAssigneeAgentId}`,
        contextSnapshot: expect.objectContaining({ wakeCommentId: existing.id }),
      }),
    );
  });

  it("repairs a correction wake failure on exact retry without reopening a newer closed state", async () => {
    const expectedAssigneeAgentId = "22222222-2222-4222-8222-222222222222";
    const comment = {
      id: "comment-wake-retry",
      issueId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      body: "Always verify the source first.",
      intent: "correction",
      idempotencyKey: "handoff.review:wake-retry",
      expectedAssigneeAgentId,
      authorAgentId: null,
      authorUserId: "local-board",
    };
    mockIssueService.getById
      .mockResolvedValueOnce(makeIssue("done"))
      .mockResolvedValueOnce({ ...makeIssue("done"), assigneeAgentId: null });
    mockIssueService.addCorrectionIdempotent
      .mockResolvedValueOnce({ comment, created: true, previousStatus: "done", assigneeChanged: false, issue: makeIssue("todo") })
      .mockResolvedValueOnce({
        comment: { ...comment, correctionRecipientAgentIds: [expectedAssigneeAgentId] },
        created: false,
        previousStatus: null,
        assigneeChanged: false,
        issue: { ...makeIssue("done"), assigneeAgentId: null },
      });
    mockIssueService.addCommentIdempotent.mockResolvedValue({ comment, created: false });
    mockHeartbeatService.wakeup.mockRejectedValueOnce(new Error("Wake queue unavailable"));
    const payload = {
      body: comment.body,
      intent: "correction",
      idempotencyKey: comment.idempotencyKey,
      expectedAssigneeAgentId,
      reopen: true,
    };

    const first = await request(await installActor(createApp()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send(payload);
    expect(first.status).toBe(500);

    const retry = await request(await installActor(createApp()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send(payload);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(2);
    expect(mockHeartbeatService.wakeup).toHaveBeenLastCalledWith(
      expectedAssigneeAgentId,
      expect.objectContaining({ idempotencyKey: `issue-comment:${comment.id}:assignee:${expectedAssigneeAgentId}` }),
    );
  });

  it.each(["paused", "terminated", "pending_approval", "budget_paused", "wake_on_demand_disabled", "deferred", "no_receipt"])(
    "saves corrections with pending delivery for %s and safely retries both comment paths",
    async (state) => {
      const targetAgentId = "22222222-2222-4222-8222-222222222222";
      for (const status of ["done", "in_progress"] as const) {
        mockIssueService.addCorrectionIdempotent.mockReset();
        mockIssueService.addCommentIdempotent.mockReset();
        mockIssueService.getById.mockResolvedValue(makeIssue(status));
        const comment = { id: `comment-${state}-${status}`, body: "Check the source.", expectedAssigneeAgentId: targetAgentId };
        mockIssueService.addCorrectionIdempotent
          .mockResolvedValueOnce({ comment, created: true, previousStatus: "done", assigneeChanged: false, issue: makeIssue("todo") })
          .mockResolvedValueOnce({ comment, created: false, previousStatus: null, assigneeChanged: false, issue: makeIssue("todo") });
        mockIssueService.addCommentIdempotent
          .mockResolvedValueOnce({ comment, created: true })
          .mockResolvedValueOnce({ comment, created: false });
        if (["wake_on_demand_disabled", "deferred", "no_receipt"].includes(state)) {
          mockHeartbeatService.wakeup.mockResolvedValueOnce(undefined);
          mockHeartbeatService.getWakeupDelivery
            .mockResolvedValueOnce({ status: "pending", reason: "Invocation is currently unavailable" })
            .mockResolvedValueOnce({ status: "pending", reason: "Invocation is currently unavailable" });
        } else {
          mockHeartbeatService.wakeup.mockRejectedValueOnce(conflict("Invocation is currently unavailable", {
            code: "invocation_blocked",
            ...(state === "budget_paused" ? { scopeType: "agent", scopeId: targetAgentId } : { status: state }),
          }));
        }
        const payload = { body: comment.body, intent: "correction", expectedAssigneeAgentId: targetAgentId, idempotencyKey: `handoff.review:${state}-${status}` };
        const app = await installActor(createApp());
        const first = await request(app).post("/api/issues/11111111-1111-4111-8111-111111111111/comments").send(payload);
        expect(first.status, JSON.stringify(first.body)).toBe(201);
        expect(first.body).toMatchObject({ id: comment.id, correctionDelivery: {
          status: "pending", pending: [{ agentId: targetAgentId, reason: "Invocation is currently unavailable" }],
        } });
        const retry = await request(app).post("/api/issues/11111111-1111-4111-8111-111111111111/comments").send(payload);
        expect(retry.status, JSON.stringify(retry.body)).toBe(200);
        expect(retry.body).toMatchObject({ id: comment.id, correctionDelivery: { status: "accepted", pending: [] } });
        const wakes = mockHeartbeatService.wakeup.mock.calls.slice(-2);
        expect(wakes.map(([agentId, options]) => [agentId, options?.idempotencyKey])).toEqual([
          [targetAgentId, `issue-comment:${comment.id}:assignee:${targetAgentId}`],
          [targetAgentId, `issue-comment:${comment.id}:assignee:${targetAgentId}`],
        ]);
        expect(mockIssueService.addComment).not.toHaveBeenCalled();
        expect(mockIssueService.update).not.toHaveBeenCalled();
      }
    },
  );

  it("atomically reassigns a correction and awaits its single durable wake", async () => {
    const targetAgentId = "33333333-3333-4333-8333-333333333333";
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    let resolveOperation!: (value: unknown) => void;
    mockIssueService.addCorrectionIdempotent.mockReturnValue(new Promise((resolve) => {
      resolveOperation = resolve;
    }));
    const payload = {
      body: "Check the source.",
      intent: "correction",
      idempotencyKey: "board.correction:v1_atomic-reassign",
      expectedAssigneeAgentId: targetAgentId,
      reassignToAgentId: targetAgentId,
      reopen: true,
    };

    const pending = request(await installActor(createApp()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send(payload)
      .then((response) => response);
    await vi.waitFor(() => expect(mockIssueService.addCorrectionIdempotent).toHaveBeenCalledTimes(1));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();

    resolveOperation({
      created: true,
      previousStatus: "done",
      assigneeChanged: true,
      issue: { ...makeIssue("todo"), assigneeAgentId: targetAgentId },
      comment: {
        id: "comment-correction-reassign",
        issueId: "11111111-1111-4111-8111-111111111111",
        companyId: "company-1",
        body: payload.body,
        intent: "correction",
        expectedAssigneeAgentId: targetAgentId,
        authorAgentId: null,
        authorUserId: "local-board",
      },
    });
    const response = await pending;

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addCommentIdempotent).not.toHaveBeenCalled();
    expect(mockIssueService.addCorrectionIdempotent).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      payload.body,
      expect.objectContaining({
        idempotencyKey: payload.idempotencyKey,
        targetAgentId,
        reopen: true,
      }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(targetAgentId, expect.objectContaining({
      idempotencyKey: `issue-comment:comment-correction-reassign:assignee:${targetAgentId}`,
      reason: "issue_assigned",
      contextSnapshot: expect.objectContaining({ wakeCommentId: "comment-correction-reassign" }),
    }));
  });

  it("requires tasks:assign even when a correction reassigns to the snapshot assignee", async () => {
    const targetAgentId = "22222222-2222-4222-8222-222222222222";
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockAccessService.canUser.mockResolvedValue(false);

    const response = await request(await installActor(createApp(), {
      type: "board",
      userId: "company-member",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({
        body: "Check the source.",
        intent: "correction",
        idempotencyKey: "board.correction:v1_same-snapshot-reassign",
        expectedAssigneeAgentId: targetAgentId,
        reassignToAgentId: targetAgentId,
        reopen: true,
      });

    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(mockAccessService.canUser).toHaveBeenCalledWith("company-1", "company-member", "tasks:assign");
    expect(mockIssueService.addCorrectionIdempotent).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("retries only durable correction side effects after response loss", async () => {
    const targetAgentId = "33333333-3333-4333-8333-333333333333";
    const newerIssue = { ...makeIssue("in_progress"), assigneeAgentId: "44444444-4444-4444-8444-444444444444" };
    const comment = {
      id: "comment-response-loss",
      issueId: newerIssue.id,
      companyId: "company-1",
      body: "Check the source.",
      intent: "correction",
      expectedAssigneeAgentId: targetAgentId,
      authorAgentId: null,
      authorUserId: "local-board",
    };
    mockIssueService.getById.mockResolvedValue(newerIssue);
    mockIssueService.addCorrectionIdempotent.mockResolvedValue({
      created: false,
      previousStatus: null,
      assigneeChanged: false,
      issue: newerIssue,
      comment,
    });

    const response = await request(await installActor(createApp()))
      .post(`/api/issues/${newerIssue.id}/comments`)
      .send({
        body: comment.body,
        intent: "correction",
        idempotencyKey: "board.correction:v1_response-loss",
        expectedAssigneeAgentId: targetAgentId,
        reassignToAgentId: targetAgentId,
        reopen: true,
      });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ status: "in_progress", assigneeAgentId: newerIssue.assigneeAgentId });
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
    // Transition activity is already committed by the service, never reconstructed from newer issue state.
    expect(mockLogActivity).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "issue.updated" }));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
  });

  it("fails closed before mutation when correction reassignment requests interruption", async () => {
    const targetAgentId = "33333333-3333-4333-8333-333333333333";
    mockIssueService.getById.mockResolvedValue(makeIssue("in_progress"));
    const response = await request(await installActor(createApp()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({
        body: "Check the source.",
        intent: "correction",
        idempotencyKey: "board.correction:v1_interrupt",
        expectedAssigneeAgentId: targetAgentId,
        reassignToAgentId: targetAgentId,
        interrupt: true,
      });

    expect(response.status).toBe(400);
    expect(mockIssueService.addCorrectionIdempotent).not.toHaveBeenCalled();
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it.each([
    ["done", true], ["cancelled", true], ["blocked", true],
    ["done", undefined], ["cancelled", undefined], ["blocked", undefined],
  ] as const)(
    "reopens a %s issue with a standard correction (explicit reopen %s) and preserves newer state on exact retry",
    async (status, reopen) => {
      const issue = makeIssue(status);
      const expectedAssigneeAgentId = issue.assigneeAgentId;
      const comment = {
        id: "comment-standard-reopen",
        issueId: issue.id,
        companyId: issue.companyId,
        body: "Check the source.",
        intent: "correction",
        idempotencyKey: "board.correction:v1_standard-reopen",
        expectedAssigneeAgentId,
        authorAgentId: null,
        authorUserId: "local-board",
      };
      mockIssueService.getById.mockResolvedValue(issue);
      const newerIssue = { ...makeIssue("done"), assigneeAgentId: "33333333-3333-4333-8333-333333333333" };
      mockIssueService.addCorrectionIdempotent
        .mockResolvedValueOnce({ comment, created: true, previousStatus: status, assigneeChanged: false, issue: { ...issue, status: "todo" } })
        .mockResolvedValueOnce({ comment, created: false, previousStatus: null, assigneeChanged: false, issue: newerIssue });
      mockIssueService.addCommentIdempotent.mockResolvedValue({ comment, created: false });
      const app = await installActor(createApp());
      const payload = {
        body: comment.body,
        intent: "correction",
        idempotencyKey: comment.idempotencyKey,
        expectedAssigneeAgentId,
        ...(reopen === undefined ? {} : { reopen }),
      };

      const first = await request(app).post(`/api/issues/${issue.id}/comments`).send(payload);
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(first.body.id).toBe(comment.id);
      expect(mockIssueService.addCorrectionIdempotent).toHaveBeenCalledExactlyOnceWith(issue.id, comment.body, expect.objectContaining({
        targetAgentId: expectedAssigneeAgentId,
        reassign: false,
        reopen: true,
        idempotencyKey: comment.idempotencyKey,
      }));
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(expectedAssigneeAgentId, expect.objectContaining({
        idempotencyKey: `issue-comment:${comment.id}:assignee:${expectedAssigneeAgentId}`,
        reason: "issue_reopened_via_comment",
        payload: expect.objectContaining({ reopenedFrom: status }),
      }));

      // The agent finished again and another agent took ownership before the response was retried.
      mockIssueService.getById.mockResolvedValue(newerIssue);
      const retry = await request(app).post(`/api/issues/${issue.id}/comments`).send(payload);
      expect(retry.status, JSON.stringify(retry.body)).toBe(200);
      expect(retry.body.id).toBe(comment.id);
      expect(mockIssueService.update).not.toHaveBeenCalled();
      expect(mockIssueService.addComment).not.toHaveBeenCalled();
      expect(mockIssueService.addCommentIdempotent).toHaveBeenCalledTimes(1);
      expect(mockIssueService.addCorrectionIdempotent).toHaveBeenCalledTimes(1);
      expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
      expect(mockHeartbeatService.wakeup).toHaveBeenLastCalledWith(expectedAssigneeAgentId, expect.objectContaining({
        idempotencyKey: `issue-comment:${comment.id}:assignee:${expectedAssigneeAgentId}`,
      }));
      expect(mockLogActivity.mock.calls.filter(([, entry]) => entry.action === "issue.updated")).toHaveLength(0);
    },
  );

  it.each([
    ["done", undefined], ["cancelled", undefined], ["blocked", undefined],
    ["done", false], ["cancelled", false], ["blocked", false],
    ["done", true], ["cancelled", true], ["blocked", true],
  ] as const)(
    "keeps a %s issue unchanged for a prior-assignee correction (explicit reopen %s)",
    async (status, reopen) => {
      const issue = makeIssue(status);
      const priorAgentId = "33333333-3333-4333-8333-333333333333";
      const comment = {
        id: "comment-prior-assignee", issueId: issue.id, companyId: issue.companyId,
        body: "Check your earlier source.", intent: "correction", expectedAssigneeAgentId: priorAgentId,
        authorAgentId: null, authorUserId: "local-board",
      };
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.addCommentIdempotent.mockResolvedValue({ comment, created: true });
      const response = await request(await installActor(createApp())).post(`/api/issues/${issue.id}/comments`).send({
        body: comment.body, intent: "correction", idempotencyKey: "handoff.review:v1_prior-no-reopen",
        expectedAssigneeAgentId: priorAgentId, allowPriorAssigneeTarget: true,
        ...(reopen === undefined ? {} : { reopen }),
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(mockIssueService.update).not.toHaveBeenCalled();
      expect(mockIssueService.addCorrectionIdempotent).not.toHaveBeenCalled();
      expect(mockIssueService.addCommentIdempotent).toHaveBeenCalledWith(issue.id, comment.body, expect.objectContaining({
        correctionRecipientAgentIds: [priorAgentId],
      }));
      expect(mockIssueService.addCommentIdempotent.mock.invocationCallOrder[0]).toBeLessThan(
        Math.min(
          mockSyncComment.mock.invocationCallOrder[0],
          mockLogActivity.mock.invocationCallOrder[0],
          mockHeartbeatService.wakeup.mock.invocationCallOrder[0],
        ),
      );
      expect(mockLogActivity).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "issue.updated" }));
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledExactlyOnceWith(priorAgentId, expect.objectContaining({
        reason: "issue_commented", idempotencyKey: `issue-comment:${comment.id}:assignee:${priorAgentId}`,
      }));
    },
  );

  it.each([null, "33333333-3333-4333-8333-333333333333"])(
    "repairs a correction retry without an explicit target after assignment changes to %s",
    async (newAssigneeAgentId) => {
      const originalIssue = makeIssue("done");
      const newerIssue = { ...makeIssue("done"), assigneeAgentId: newAssigneeAgentId };
      const comment = {
        id: "comment-inferred-target", issueId: originalIssue.id, companyId: originalIssue.companyId,
        body: "Check the source.", intent: "correction", expectedAssigneeAgentId: originalIssue.assigneeAgentId,
        authorAgentId: null, authorUserId: "local-board",
      };
      const payload = { body: comment.body, intent: "correction", idempotencyKey: "board.correction:v1_inferred-target" };
      mockIssueService.getById.mockResolvedValueOnce(originalIssue).mockResolvedValue(newerIssue);
      mockIssueService.getCommentByIdempotencyKey.mockResolvedValueOnce(null).mockResolvedValue(comment);
      mockIssueService.addCorrectionIdempotent
        .mockResolvedValueOnce({ comment, created: true, previousStatus: "done", assigneeChanged: false, issue: makeIssue("todo") })
        .mockResolvedValue({ comment, created: false, previousStatus: null, assigneeChanged: false, issue: newerIssue });
      mockIssueService.addCommentIdempotent.mockResolvedValue({ comment, created: false });
      // Fail after the state/comment/activity transaction committed but before delivery.
      mockLogActivity.mockRejectedValueOnce(new Error("Comment activity unavailable"));
      const app = await installActor(createApp());
      expect((await request(app).post(`/api/issues/${originalIssue.id}/comments`).send(payload)).status).toBe(500);
      expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();

      const retry = await request(app).post(`/api/issues/${originalIssue.id}/comments`).send(payload);
      expect(retry.status, JSON.stringify(retry.body)).toBe(200);
      expect(retry.body.id).toBe(comment.id);
      expect(mockIssueService.addCommentIdempotent.mock.lastCall?.[2]).toMatchObject({
        expectedAssigneeAgentId: originalIssue.assigneeAgentId,
      });
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledExactlyOnceWith(originalIssue.assigneeAgentId, expect.objectContaining({
        idempotencyKey: `issue-comment:${comment.id}:assignee:${originalIssue.assigneeAgentId}`,
      }));
      expect(mockIssueService.update).not.toHaveBeenCalled();
      expect(mockLogActivity).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "issue.updated" }));
    },
  );

  it("does not reopen a newer closed state during ordinary correction replay", async () => {
    const expectedAssigneeAgentId = "22222222-2222-4222-8222-222222222222";
    const closedIssue = makeIssue("done");
    const existing = {
      id: "comment-ordinary-replay-closed",
      issueId: closedIssue.id,
      companyId: "company-1",
      body: "Check the source.",
      intent: "correction",
      idempotencyKey: "board.correction:v1_closed-replay",
      expectedAssigneeAgentId,
      authorAgentId: null,
      authorUserId: "local-board",
    };
    mockIssueService.getById.mockResolvedValue(closedIssue);
    mockIssueService.addCorrectionIdempotent.mockResolvedValue({
      comment: existing, created: false, previousStatus: null, assigneeChanged: false, issue: closedIssue,
    });

    const response = await request(await installActor(createApp()))
      .post(`/api/issues/${closedIssue.id}/comments`)
      .send({
        body: existing.body,
        intent: "correction",
        idempotencyKey: existing.idempotencyKey,
        expectedAssigneeAgentId,
        reopen: true,
      });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(expectedAssigneeAgentId, expect.objectContaining({
      idempotencyKey: `issue-comment:${existing.id}:assignee:${expectedAssigneeAgentId}`,
    }));
  });

  it("implicitly reopens closed issues via the PATCH comment path when reassigning to an agent", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("done"),
      ...patch,
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello", assigneeAgentId: "33333333-3333-4333-8333-333333333333" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        status: "todo",
        actorAgentId: null,
        actorUserId: "local-board",
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.objectContaining({
          reopened: true,
          reopenedFrom: "done",
          status: "todo",
        }),
      }),
    );
  });

  it("resolves assignee shortnames before updating an issue", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("todo"),
      ...patch,
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello", assigneeAgentId: "codexcoder" });

    expect(res.status).toBe(200);
    expect(mockAgentService.resolveByReference).toHaveBeenCalledWith("company-1", "codexcoder");
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      }),
    );
  });

  it("rejects ambiguous assignee shortnames", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ assigneeAgentId: "ambiguous-codex" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("ambiguous");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects missing assignee shortnames", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ assigneeAgentId: "missing-codex" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Agent not found");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });
  it("reopens closed issues via the PATCH comment path", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("done"),
      ...patch,
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello", reopen: true, assigneeAgentId: "33333333-3333-4333-8333-333333333333" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        status: "todo",
        actorAgentId: null,
        actorUserId: "local-board",
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.objectContaining({
          reopened: true,
          reopenedFrom: "done",
          status: "todo",
        }),
      }),
    );
  });

  it("implicitly reopens closed issues via POST comments when an agent is assigned", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("done"),
      ...patch,
    }));

    const res = await request(await installActor(createApp()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "hello" });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { status: "todo" },
    );
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "issue_reopened_via_comment",
        payload: expect.objectContaining({
          reopenedFrom: "done",
        }),
      }),
    ));
  });

  it("does not implicitly reopen closed issues via POST comments for agent-authored comments", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      body: "hello",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: "33333333-3333-4333-8333-333333333333",
      authorUserId: null,
    });

    const res = await request(await installActor(createApp(), {
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      source: "agent_key",
      runId: "77777777-7777-4777-8777-777777777777",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "hello" });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).not.toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { status: "todo" },
    );
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("moves assigned blocked issues back to todo via POST comments", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("blocked"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("blocked"),
      ...patch,
    }));

    const res = await request(await installActor(createApp()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "please continue" });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { status: "todo" },
    );
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "issue_reopened_via_comment",
        payload: expect.objectContaining({
          commentId: "comment-1",
          reopenedFrom: "blocked",
          mutation: "comment",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: "11111111-1111-4111-8111-111111111111",
          wakeCommentId: "comment-1",
          wakeReason: "issue_reopened_via_comment",
          reopenedFrom: "blocked",
        }),
      }),
    ));
  });

  it("does not move dependency-blocked issues to todo via POST comments", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("blocked"));
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: "11111111-1111-4111-8111-111111111111",
      blockerIssueIds: ["33333333-3333-4333-8333-333333333333"],
      unresolvedBlockerIssueIds: ["33333333-3333-4333-8333-333333333333"],
      unresolvedBlockerCount: 1,
      allBlockersDone: false,
      isDependencyReady: false,
    });

    const res = await request(await installActor(createApp()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "what is happening?" });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "issue_commented",
        payload: expect.objectContaining({
          commentId: "comment-1",
          mutation: "comment",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: "11111111-1111-4111-8111-111111111111",
          wakeCommentId: "comment-1",
          wakeReason: "issue_commented",
        }),
      }),
    ));
  });

  it("does not implicitly reopen closed issues via POST comments when no agent is assigned", async () => {
    mockIssueService.getById.mockResolvedValue({
      ...makeIssue("done"),
      assigneeAgentId: null,
      assigneeUserId: "local-board",
    });

    const res = await request(await installActor(createApp()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "hello" });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("moves assigned blocked issues back to todo via the PATCH comment path", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("blocked"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("blocked"),
      ...patch,
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "please continue" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        status: "todo",
        actorAgentId: null,
        actorUserId: "local-board",
      }),
    );
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "issue_reopened_via_comment",
        payload: expect.objectContaining({
          commentId: "comment-1",
          reopenedFrom: "blocked",
          mutation: "comment",
        }),
      }),
    ));
  });

  it("does not implicitly reopen closed issues via the PATCH comment path for agent-authored comments", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      body: "hello",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: "33333333-3333-4333-8333-333333333333",
      authorUserId: null,
    });
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("done"),
      ...patch,
    }));

    const res = await request(await installActor(createApp(), {
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      source: "agent_key",
      runId: "88888888-8888-4888-8888-888888888888",
    }))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).not.toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ status: "todo" }),
    );
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("does not move dependency-blocked issues to todo via the PATCH comment path", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("blocked"));
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: "11111111-1111-4111-8111-111111111111",
      blockerIssueIds: ["33333333-3333-4333-8333-333333333333"],
      unresolvedBlockerIssueIds: ["33333333-3333-4333-8333-333333333333"],
      unresolvedBlockerCount: 1,
      allBlockersDone: false,
      isDependencyReady: false,
    });
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("blocked"),
      ...patch,
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "what is happening?" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        actorAgentId: null,
        actorUserId: "local-board",
      }),
    );
    expect(mockIssueService.update).not.toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ status: "todo" }),
    );
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "issue_commented",
        payload: expect.objectContaining({
          commentId: "comment-1",
          mutation: "comment",
        }),
      }),
    ));
  });

  it("wakes the assignee when an assigned blocked issue moves back to todo", async () => {
    const issue = makeIssue("blocked");
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "todo" });

    expect(res.status).toBe(200);
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        source: "automation",
        triggerDetail: "system",
        reason: "issue_status_changed",
        payload: expect.objectContaining({
          issueId: "11111111-1111-4111-8111-111111111111",
          mutation: "update",
        }),
      }),
    ));
  });

  it("wakes the assignee when an assigned done issue moves back to todo", async () => {
    const issue = makeIssue("done");
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "todo" });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        source: "automation",
        triggerDetail: "system",
        reason: "issue_status_changed",
        payload: expect.objectContaining({
          issueId: "11111111-1111-4111-8111-111111111111",
          mutation: "update",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: "11111111-1111-4111-8111-111111111111",
          source: "issue.status_change",
        }),
      }),
    );
  });

  it("explicit same-agent resume works through the PATCH comment path", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("done"),
      ...patch,
    }));

    const res = await request(await installActor(createApp(), agentActor()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "please validate the follow-up", resume: true });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        status: "todo",
        actorAgentId: "22222222-2222-4222-8222-222222222222",
        actorUserId: null,
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.comment_added",
        details: expect.objectContaining({
          commentId: "comment-1",
          resumeIntent: true,
          followUpRequested: true,
        }),
      }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "issue_reopened_via_comment",
        payload: expect.objectContaining({
          commentId: "comment-1",
          reopenedFrom: "done",
          resumeIntent: true,
          followUpRequested: true,
        }),
      }),
    );
  });

  it("keeps generic same-agent comments on closed issues inert", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));

    const res = await request(await installActor(createApp(), agentActor()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "follow-up note without intent" });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("explicit same-agent resume comments reopen closed issues and mark the wake payload", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("done"),
      ...patch,
    }));

    const res = await request(await installActor(createApp(), agentActor()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "please validate the follow-up", resume: true });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { status: "todo" },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.comment_added",
        details: expect.objectContaining({
          commentId: "comment-1",
          resumeIntent: true,
          followUpRequested: true,
        }),
      }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "issue_reopened_via_comment",
        payload: expect.objectContaining({
          commentId: "comment-1",
          reopenedFrom: "done",
          resumeIntent: true,
          followUpRequested: true,
        }),
        contextSnapshot: expect.objectContaining({
          wakeReason: "issue_reopened_via_comment",
          resumeIntent: true,
          followUpRequested: true,
        }),
      }),
    );
  });

  it("rejects explicit agent resume intent from a non-assignee", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));

    const res = await request(await installActor(createApp(), agentActor("44444444-4444-4444-8444-444444444444")))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "restart someone else's work", resume: true });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agent cannot request follow-up for another agent's issue");
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("rejects explicit resume intent under an active pause hold", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueTreeControlService.getActivePauseHoldGate.mockResolvedValue({
      holdId: "hold-1",
      rootIssueId: "root-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      isRoot: false,
      mode: "pause",
      reason: "reviewing",
      releasePolicy: null,
    });

    const res = await request(await installActor(createApp(), agentActor()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "please resume", resume: true });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Issue follow-up blocked by active subtree pause hold");
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("rejects explicit resume intent on cancelled issues", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("cancelled"));

    const res = await request(await installActor(createApp(), agentActor()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "please resume", resume: true });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Cancelled issues must be restored through the dedicated restore flow");
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("interrupts an active run before a combined comment update", async () => {
    const issue = {
      ...makeIssue("todo"),
      executionRunId: "run-1",
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
    }));
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "running",
    });
    mockHeartbeatService.cancelRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "cancelled",
    });

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello", interrupt: true, assigneeAgentId: "33333333-3333-4333-8333-333333333333" });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.getRun).toHaveBeenCalledWith("run-1");
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("run-1");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "heartbeat.cancelled",
        details: expect.objectContaining({
          source: "issue_comment_interrupt",
          issueId: "11111111-1111-4111-8111-111111111111",
        }),
      }),
    );
  });

  it("cancels an active run when an issue is marked cancelled", async () => {
    const issue = {
      ...makeIssue("in_progress"),
      executionRunId: "run-1",
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
    }));
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "running",
    });
    mockHeartbeatService.cancelRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "cancelled",
    });

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "cancelled" });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.getRun).toHaveBeenCalledWith("run-1");
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("run-1");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "heartbeat.cancelled",
        details: expect.objectContaining({
          source: "issue_status_cancelled",
          issueId: "11111111-1111-4111-8111-111111111111",
        }),
      }),
    );
  });

  it("does not cancel active runs when an issue is marked done", async () => {
    const issue = {
      ...makeIssue("in_progress"),
      executionRunId: "run-1",
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
    }));
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "running",
    });

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });

  it("writes decision ids into executionState and inserts the decision inside the transaction", async () => {
    const policy = await normalizePolicy({
      stages: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "approval",
          participants: [{ type: "user", userId: "local-board" }],
        },
      ],
    })!;
    const issue = {
      ...makeIssue("todo"),
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "approval",
        currentParticipant: { type: "user", userId: "local-board" },
        returnAssignee: { type: "agent", agentId: "22222222-2222-4222-8222-222222222222" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>, tx?: unknown) => ({
      ...issue,
      ...patch,
      executionState: patch.executionState,
      status: "done",
      completedAt: new Date(),
      updatedAt: new Date(),
      _tx: tx,
    }));

    const res = await request(await installActor(createApp()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done", comment: "Approved for ship" });

    expect(res.status).toBe(200);
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        executionState: expect.objectContaining({
          status: "completed",
          lastDecisionId: expect.any(String),
          lastDecisionOutcome: "approved",
        }),
      }),
      mockTx,
    );
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, any>;
    const decisionId = updatePatch.executionState.lastDecisionId;
    expect(mockTxInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        id: decisionId,
        issueId: "11111111-1111-4111-8111-111111111111",
        outcome: "approved",
        body: "Approved for ship",
      }),
    );
  });

  it("coerces executor handoff patches into workflow-controlled review wakes", async () => {
    const policy = await normalizePolicy({
      stages: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
      ],
    })!;
    const issue = {
      ...makeIssue("todo"),
      status: "in_progress",
      assigneeAgentId: "22222222-2222-4222-8222-222222222222",
      executionPolicy: policy,
      executionPolicyExplicit: true,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(
      await installActor(createApp(), {
        type: "agent",
        agentId: "22222222-2222-4222-8222-222222222222",
        companyId: "company-1",
        runId: "run-1",
      }),
    )
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({
        status: "in_review",
        assigneeAgentId: null,
        assigneeUserId: "local-board",
        reviewRequest: {
          instructions: "Please verify the fix against the reproduction steps and note any residual risk.",
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.assigneeAgentId).toBe("33333333-3333-4333-8333-333333333333");
    expect(res.body.assigneeUserId).toBeNull();
    expect(res.body.executionState).toMatchObject({
      status: "pending",
      currentStageType: "review",
      currentParticipant: {
        type: "agent",
        agentId: "33333333-3333-4333-8333-333333333333",
      },
      returnAssignee: {
        type: "agent",
        agentId: "22222222-2222-4222-8222-222222222222",
      },
      reviewRequest: {
        instructions: "Please verify the fix against the reproduction steps and note any residual risk.",
      },
    });
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
      expect.objectContaining({
        reason: "execution_review_requested",
        payload: expect.objectContaining({
          issueId: "11111111-1111-4111-8111-111111111111",
          executionStage: expect.objectContaining({
            wakeRole: "reviewer",
            stageType: "review",
            reviewRequest: {
              instructions: "Please verify the fix against the reproduction steps and note any residual risk.",
            },
            allowedActions: ["approve", "request_changes"],
          }),
        }),
      }),
    ));
  });

  it("wakes the return assignee with execution_changes_requested", async () => {
    const policy = await normalizePolicy({
      stages: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
      ],
    })!;
    const issue = {
      ...makeIssue("todo"),
      status: "in_review",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
        returnAssignee: { type: "agent", agentId: "22222222-2222-4222-8222-222222222222" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(
      await installActor(createApp(), {
        type: "agent",
        agentId: "33333333-3333-4333-8333-333333333333",
        companyId: "company-1",
        runId: "run-2",
      }),
    )
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({
        status: "in_progress",
        comment: "Needs another pass",
      });

    expect(res.status).toBe(200);
    await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "execution_changes_requested",
        payload: expect.objectContaining({
          issueId: "11111111-1111-4111-8111-111111111111",
          executionStage: expect.objectContaining({
            wakeRole: "executor",
            stageType: "review",
            lastDecisionOutcome: "changes_requested",
            allowedActions: ["address_changes", "resubmit"],
          }),
        }),
      }),
    ));
  });
});
