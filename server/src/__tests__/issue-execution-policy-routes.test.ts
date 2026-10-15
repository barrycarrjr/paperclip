import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  defaultExecutionPolicyForAssignee: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  resolveByReference: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
        },
      })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
    }),
    issueApprovalService: () => ({}),
    issueThreadInteractionService: () => ({
      expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    }),
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
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
}

async function createApp(actor?: Express.Request["actor"]) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
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
  const db = {
    transaction: async (callback: (tx: any) => Promise<unknown>) => callback({
      insert: () => ({ values: async () => undefined }),
    }),
  };
  app.use("/api", issueRoutes(db as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue execution policy routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.defaultExecutionPolicyForAssignee.mockResolvedValue(null);
    mockIssueService.addComment.mockImplementation(async (_id: string, body: string) => ({
      id: "comment-1",
      body,
      intent: null,
    }));
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAccessService.getMembership.mockResolvedValue({ id: "membership-1", status: "active" });
    mockAgentService.getById.mockImplementation(async (id: string) => ({
      id,
      companyId: "company-1",
      status: "idle",
    }));
    mockAgentService.resolveByReference.mockImplementation(async (_companyId: string, reference: string) => ({
      agent: { id: reference, companyId: "company-1", status: "idle" },
      ambiguous: false,
    }));
  });

  it("does not auto-start execution review when reviewers are added to an already in_review issue", async () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
      ],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      createdByUserId: "local-board",
      identifier: "PAP-999",
      title: "Execution policy edit",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ executionPolicy: policy });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        executionPolicy: policy,
        actorAgentId: null,
        actorUserId: "local-board",
      }),
    );
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updatePatch.status).toBeUndefined();
    expect(updatePatch.assigneeAgentId).toBeUndefined();
    expect(updatePatch.assigneeUserId).toBeUndefined();
    expect(updatePatch.executionState).toBeUndefined();
    expect(updatePatch.expectedExecutionPolicy).toEqual(null);
    expect(updatePatch.expectedExecutionState).toEqual(null);
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  }, 10_000);

  it("starts automatic review when assignment and completion are requested together", async () => {
    const workerId = "22222222-2222-4222-8222-222222222222";
    const reviewerId = "33333333-3333-4333-8333-333333333333";
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: reviewerId }],
        },
      ],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1000",
      title: "Automatic review assignment",
      executionPolicy: null,
      executionPolicyExplicit: false,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.defaultExecutionPolicyForAssignee.mockResolvedValue(policy);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ assigneeAgentId: workerId, status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      issue.id,
      expect.objectContaining({
        executionPolicy: policy,
        executionPolicyExplicit: false,
        status: "in_review",
        assigneeAgentId: reviewerId,
      }),
    );
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, any>;
    expect(updatePatch.executionState).toMatchObject({
      status: "pending",
      currentParticipant: { type: "agent", agentId: reviewerId },
      returnAssignee: { type: "agent", agentId: workerId },
    });
    expect(updatePatch.expectedExecutionPolicy).toEqual(null);
    expect(updatePatch.expectedExecutionState).toEqual(null);
  });

  it("guards review-request edits against concurrent review-state changes", async () => {
    const reviewerId = "33333333-3333-4333-8333-333333333333";
    const policy = normalizeIssueExecutionPolicy({
      stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewerId }] }],
    })!;
    const executionState = {
      status: "pending",
      currentStageId: policy.stages[0].id,
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: reviewerId },
      returnAssignee: { type: "agent", agentId: "22222222-2222-4222-8222-222222222222" },
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
      reviewRequest: null,
    };
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: reviewerId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1004",
      title: "Guard review instructions",
      executionPolicy: policy,
      executionPolicyExplicit: false,
      executionState,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ reviewRequest: { instructions: "Check the final behavior." } });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, any>;
    expect(updatePatch.executionState.reviewRequest).toEqual({ instructions: "Check the final behavior." });
    expect(updatePatch.expectedExecutionPolicy).toEqual(policy);
    expect(updatePatch.expectedExecutionState).toEqual(executionState);
  });

  it("keeps the existing automatic policy when the assignee field is unchanged", async () => {
    const workerId = "22222222-2222-4222-8222-222222222222";
    const reviewerId = "33333333-3333-4333-8333-333333333333";
    const policy = normalizeIssueExecutionPolicy({
      stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewerId }] }],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: workerId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Unchanged automatic review assignment",
      executionPolicy: policy,
      executionPolicyExplicit: false,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: workerId, status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.defaultExecutionPolicyForAssignee).not.toHaveBeenCalled();
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, any>;
    expect(updatePatch.executionPolicy).toBeUndefined();
    expect(updatePatch.status).toBe("in_review");
    expect(updatePatch.assigneeAgentId).toBe(reviewerId);
    expect(updatePatch.executionState).toMatchObject({
      currentStageId: policy.stages[0].id,
      returnAssignee: { type: "agent", agentId: workerId },
    });
  });

  it("keeps the worker's policy when completion names its configured reviewer", async () => {
    const workerId = "22222222-2222-4222-8222-222222222222";
    const reviewerId = "33333333-3333-4333-8333-333333333333";
    const policy = normalizeIssueExecutionPolicy({
      stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewerId }] }],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: workerId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1002",
      title: "Explicit reviewer handoff",
      executionPolicy: policy,
      executionPolicyExplicit: false,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: reviewerId, status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.defaultExecutionPolicyForAssignee).not.toHaveBeenCalled();
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, any>;
    expect(updatePatch.executionPolicy).toBeUndefined();
    expect(updatePatch.status).toBe("in_review");
    expect(updatePatch.assigneeAgentId).toBe(reviewerId);
    expect(updatePatch.executionState).toMatchObject({
      currentStageId: policy.stages[0].id,
      currentParticipant: { type: "agent", agentId: reviewerId },
      returnAssignee: { type: "agent", agentId: workerId },
    });
  });

  it("keeps the active policy when a reviewer returns work to its worker", async () => {
    const workerId = "22222222-2222-4222-8222-222222222222";
    const reviewerId = "33333333-3333-4333-8333-333333333333";
    const policy = normalizeIssueExecutionPolicy({
      stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewerId }] }],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: reviewerId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1003",
      title: "Return reviewed work",
      executionPolicy: policy,
      executionPolicyExplicit: false,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerId },
        returnAssignee: { type: "agent", agentId: workerId },
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

    const res = await request(await createApp({
      type: "agent",
      agentId: reviewerId,
      companyId: "company-1",
      source: "agent_jwt",
    } as Express.Request["actor"]))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: workerId, status: "in_progress", comment: "Please fix this." });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.defaultExecutionPolicyForAssignee).not.toHaveBeenCalled();
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, any>;
    expect(updatePatch.executionPolicy).toBeUndefined();
    expect(updatePatch.status).toBe("in_progress");
    expect(updatePatch.assigneeAgentId).toBe(workerId);
    expect(updatePatch.executionState).toMatchObject({
      currentStageId: policy.stages[0].id,
      status: "changes_requested",
      returnAssignee: { type: "agent", agentId: workerId },
    });
  });

  it("requires assignment permission when final approval names another assignee", async () => {
    const workerId = "22222222-2222-4222-8222-222222222222";
    const reviewerId = "33333333-3333-4333-8333-333333333333";
    const otherAgentId = "44444444-4444-4444-8444-444444444444";
    const policy = normalizeIssueExecutionPolicy({
      stages: [{ type: "approval", participants: [{ type: "agent", agentId: reviewerId }] }],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: reviewerId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1005",
      title: "Protect approval assignment",
      executionPolicy: policy,
      executionPolicyExplicit: true,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "approval",
        currentParticipant: { type: "agent", agentId: reviewerId },
        returnAssignee: { type: "agent", agentId: workerId },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        reviewRequest: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp({
      type: "agent",
      agentId: reviewerId,
      companyId: "company-1",
      source: "agent_jwt",
    } as Express.Request["actor"]))
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "done", assigneeAgentId: otherAgentId, comment: "Approved." });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("requires assignment permission before deriving another worker's reviewer policy", async () => {
    const currentWorkerId = "11111111-1111-4111-8111-111111111111";
    const requestedWorkerId = "22222222-2222-4222-8222-222222222222";
    const reviewerId = "33333333-3333-4333-8333-333333333333";
    const policy = normalizeIssueExecutionPolicy({
      stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewerId }] }],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: currentWorkerId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1006",
      title: "Protect derived reviewer assignment",
      executionPolicy: null,
      executionPolicyExplicit: false,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.defaultExecutionPolicyForAssignee.mockResolvedValue(policy);

    const res = await request(await createApp({
      type: "agent",
      agentId: currentWorkerId,
      companyId: "company-1",
      source: "agent_jwt",
      runId: "55555555-5555-4555-8555-555555555555",
    } as Express.Request["actor"]))
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "done", assigneeAgentId: requestedWorkerId, comment: "Completed." });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("requires assignment permission when the derived reviewer keeps the final assignee unchanged", async () => {
    const currentWorkerId = "11111111-1111-4111-8111-111111111111";
    const requestedWorkerId = "22222222-2222-4222-8222-222222222222";
    const policy = normalizeIssueExecutionPolicy({
      stages: [{ type: "review", participants: [{ type: "agent", agentId: currentWorkerId }] }],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: currentWorkerId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1007",
      title: "Protect unchanged reviewer assignment",
      executionPolicy: null,
      executionPolicyExplicit: false,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.defaultExecutionPolicyForAssignee.mockResolvedValue(policy);

    const res = await request(await createApp({
      type: "agent",
      agentId: currentWorkerId,
      companyId: "company-1",
      source: "agent_jwt",
      runId: "55555555-5555-4555-8555-555555555555",
    } as Express.Request["actor"]))
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "done", assigneeAgentId: requestedWorkerId, comment: "Completed." });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects a terminated requested worker before a reviewer handoff can hide it", async () => {
    const currentWorkerId = "11111111-1111-4111-8111-111111111111";
    const terminatedWorkerId = "22222222-2222-4222-8222-222222222222";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: currentWorkerId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1008",
      title: "Reject unavailable return worker",
      executionPolicy: null,
      executionPolicyExplicit: false,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockAgentService.resolveByReference.mockResolvedValue({
      agent: { id: terminatedWorkerId, companyId: "company-1", status: "terminated" },
      ambiguous: false,
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "done", assigneeAgentId: terminatedWorkerId });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(mockIssueService.defaultExecutionPolicyForAssignee).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects a nonmember requested return user before reviewer handoff", async () => {
    const workerId = "11111111-1111-4111-8111-111111111111";
    const reviewerId = "22222222-2222-4222-8222-222222222222";
    const nonmemberUserId = "33333333-3333-4333-8333-333333333333";
    const policy = normalizeIssueExecutionPolicy({
      stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewerId }] }],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: workerId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1009",
      title: "Reject unavailable return user",
      executionPolicy: policy,
      executionPolicyExplicit: true,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockAccessService.getMembership.mockResolvedValue(null);

    const res = await request(await createApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "done", assigneeUserId: nonmemberUserId });

    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("does not treat a creator review handoff as permission to assign an unrelated worker", async () => {
    const workerId = "11111111-1111-4111-8111-111111111111";
    const unrelatedWorkerId = "22222222-2222-4222-8222-222222222222";
    const creatorUserId = "33333333-3333-4333-8333-333333333333";
    const policy = normalizeIssueExecutionPolicy({
      stages: [{ type: "review", participants: [{ type: "user", userId: creatorUserId }] }],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: workerId,
      assigneeUserId: null,
      createdByUserId: creatorUserId,
      identifier: "PAP-1010",
      title: "Protect creator review handoff",
      executionPolicy: policy,
      executionPolicyExplicit: true,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp({
      type: "agent",
      agentId: workerId,
      companyId: "company-1",
      source: "agent_jwt",
      runId: "55555555-5555-4555-8555-555555555555",
    } as Express.Request["actor"]))
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "done", assigneeAgentId: unrelatedWorkerId });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });
});
