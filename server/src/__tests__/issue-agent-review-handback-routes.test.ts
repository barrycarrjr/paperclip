import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #184: an agent that finishes work it holds and marks it in_review, without
 * naming a reviewer, gets the issue handed back to the person who created it.
 * Before this the issue sat in_review on the agent and nobody saw it.
 */

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const ownerAgentId = "33333333-3333-4333-8333-333333333333";
const otherAgentId = "44444444-4444-4444-8444-444444444444";
const ownerRunId = "55555555-5555-4555-8555-555555555555";
const stageId = "66666666-6666-4666-8666-666666666666";
const creatorUserId = "board-user";
const reviewerUserId = "reviewer-user";

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getAttachmentById: vi.fn(),
  getByIdentifier: vi.fn(),
  getById: vi.fn(),
  getRelationSummaries: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  listAttachments: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  remove: vi.fn(),
  removeAttachment: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  findMentionedAgents: vi.fn(),
  defaultExecutionPolicyForAssignee: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  getMembership: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockWakeup = vi.hoisted(() => vi.fn(async () => undefined));

const mockStorageService = vi.hoisted(() => ({
  provider: "local_disk",
  putFile: vi.fn(),
  getObject: vi.fn(),
  headObject: vi.fn(),
  deleteObject: vi.fn(),
}));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));

function registerRouteMocks() {
  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));
  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));
  vi.doMock("../services/documents.js", () => ({
    documentService: () => ({ upsertIssueDocument: vi.fn() }),
  }));
  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));
  vi.doMock("../services/work-products.js", () => ({
    workProductService: () => ({ getById: vi.fn(), update: vi.fn() }),
  }));
  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    documentService: () => ({ upsertIssueDocument: vi.fn() }),
    executionWorkspaceService: () => ({}),
    goalService: () => ({}),
    heartbeatService: () => ({
      wakeup: mockWakeup,
      reportRunActivity: vi.fn(async () => undefined),
      getRun: vi.fn(async () => null),
      getActiveRunForAgent: vi.fn(async () => null),
      cancelRun: vi.fn(async () => null),
    }),
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: { censorUsernameInLogs: false },
      })),
      listCompanyIds: vi.fn(async () => [companyId]),
    }),
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
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({ getById: vi.fn(), update: vi.fn() }),
  }));
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId,
    status: "in_progress",
    priority: "high",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: ownerAgentId,
    assigneeUserId: null,
    createdByUserId: creatorUserId,
    identifier: "PAP-184",
    title: "Finished feature",
    executionPolicy: null,
    executionPolicyExplicit: false,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

function makeAgent(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    companyId,
    role: "engineer",
    reportsTo: null,
    permissions: { canCreateAgents: false },
    ...overrides,
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes({} as any, mockStorageService as any));
  app.use(errorHandler);
  return app;
}

function agentActor(agentId = ownerAgentId) {
  return {
    type: "agent",
    agentId,
    companyId,
    source: "agent_key",
    runId: ownerRunId,
  };
}

function boardActor() {
  return {
    type: "board",
    userId: creatorUserId,
    companyIds: [companyId],
    source: "local_implicit",
    isInstanceAdmin: false,
  };
}

function updatePatch(): Record<string, unknown> {
  expect(mockIssueService.update).toHaveBeenCalledTimes(1);
  return mockIssueService.update.mock.calls[0][1] as Record<string, unknown>;
}

function issueUpdatedDetails(): Record<string, unknown> {
  const call = mockLogActivity.mock.calls.find(
    (args) => (args as unknown as [unknown, { action: string }])[1]?.action === "issue.updated",
  ) as unknown as [unknown, { details: Record<string, unknown> }] | undefined;
  expect(call).toBeDefined();
  return call![1].details;
}

async function flushBackgroundWork() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("agent finishing held work hands it back to its creator (#184)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/documents.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../services/work-products.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerRouteMocks();
    vi.clearAllMocks();
    mockAccessService.canUser.mockResolvedValue(true);
    // The agent may NOT assign tasks in general: the hand-back must not need it.
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAccessService.getMembership.mockResolvedValue({ status: "active" });
    mockAgentService.getById.mockResolvedValue(makeAgent(ownerAgentId, { permissions: { canAssignTasks: false } }));
    mockAgentService.list.mockResolvedValue([makeAgent(ownerAgentId), makeAgent(otherAgentId)]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: null });
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.defaultExecutionPolicyForAssignee.mockResolvedValue(null);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue(),
      ...patch,
    }));
    mockIssueService.addComment.mockResolvedValue({
      id: "77777777-7777-4777-8777-777777777777",
      issueId,
      companyId,
      body: "comment",
    });
  });

  it("returns the issue to the creator when the holding agent sets in_review without naming anyone", async () => {
    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    const patch = updatePatch();
    expect(patch.status).toBe("in_review");
    expect(patch.assigneeAgentId).toBeNull();
    expect(patch.assigneeUserId).toBe(creatorUserId);
    expect(mockAccessService.getMembership).toHaveBeenCalledWith(companyId, "user", creatorUserId);

    const details = issueUpdatedDetails();
    expect(details.autoReturnedToCreator).toBe(true);
    expect(details.assigneeUserId).toBe(creatorUserId);
    expect((details._previous as Record<string, unknown>).assigneeAgentId).toBe(ownerAgentId);

    await flushBackgroundWork();
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("does not demand a handoff note for the automatic hand-back, and still posts one if given", async () => {
    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review", comment: "Done, see the plan document." });

    expect(res.status).toBe(200);
    expect(updatePatch().assigneeUserId).toBe(creatorUserId);
    expect(mockIssueService.addComment).toHaveBeenCalled();
  });

  it("leaves the assignee alone when the request names an agent assignee", async () => {
    mockAgentService.resolveByReference.mockResolvedValue({
      ambiguous: false,
      agent: makeAgent(ownerAgentId, { status: "active" }),
    });

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review", assigneeAgentId: ownerAgentId });

    expect(res.status).toBe(200);
    const patch = updatePatch();
    expect(patch.assigneeUserId).toBeUndefined();
    expect(issueUpdatedDetails().autoReturnedToCreator).toBeUndefined();
  });

  it("uses the person the request names instead of the creator", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAgentService.getById.mockResolvedValue(makeAgent(ownerAgentId, { permissions: { canAssignTasks: true } }));

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review", assigneeUserId: reviewerUserId, comment: "Please review the copy." });

    expect(res.status).toBe(200);
    expect(updatePatch().assigneeUserId).toBe(reviewerUserId);
    expect(issueUpdatedDetails().autoReturnedToCreator).toBeUndefined();
  });

  it("lets a review stage decide the assignee instead of the creator", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            id: stageId,
            type: "review",
            approvalsNeeded: 1,
            participants: [{ id: "88888888-8888-4888-8888-888888888888", type: "user", userId: reviewerUserId, agentId: null }],
          },
        ],
      },
      executionPolicyExplicit: true,
    }));

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review", comment: "Ready for review." });

    expect(res.status).toBe(200);
    const patch = updatePatch();
    expect(patch.assigneeAgentId).toBeNull();
    expect(patch.assigneeUserId).toBe(reviewerUserId);
    expect((patch.executionState as Record<string, unknown>).status).toBe("pending");
    expect(issueUpdatedDetails().autoReturnedToCreator).toBeUndefined();
  });

  it("does nothing while a pending stage has the holding agent as its reviewer", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({
      status: "in_review",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            id: stageId,
            type: "review",
            approvalsNeeded: 1,
            participants: [{ id: "88888888-8888-4888-8888-888888888888", type: "agent", agentId: ownerAgentId, userId: null }],
          },
        ],
      },
      executionPolicyExplicit: true,
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: ownerAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: otherAgentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }));

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    const patch = updatePatch();
    expect(patch.assigneeUserId).toBeUndefined();
    expect(patch.assigneeAgentId).toBeUndefined();
  });

  it("does nothing when the agent does not hold the issue", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "todo", assigneeAgentId: otherAgentId }));

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(updatePatch().assigneeUserId).toBeUndefined();
  });

  it("does nothing when a board user sets in_review", async () => {
    const res = await request(await createApp(boardActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(updatePatch().assigneeUserId).toBeUndefined();
  });

  it("does nothing when an agent created the issue", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ createdByUserId: null, createdByAgentId: otherAgentId }));

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    const patch = updatePatch();
    expect(patch.assigneeUserId).toBeUndefined();
    expect(patch.assigneeAgentId).toBeUndefined();
  });

  it("does nothing when the creator is no longer an active member", async () => {
    mockAccessService.getMembership.mockResolvedValue({ status: "suspended" });

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(updatePatch().assigneeUserId).toBeUndefined();
  });

  it("does nothing on an unrelated edit to an issue that is already in_review", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "in_review" }));

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ priority: "low" });

    expect(res.status).toBe(200);
    expect(updatePatch().assigneeUserId).toBeUndefined();
  });

  it("does nothing when the agent moves held work to a status other than in_review", async () => {
    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "blocked" });

    expect(res.status).toBe(200);
    expect(updatePatch().assigneeUserId).toBeUndefined();
  });
});
