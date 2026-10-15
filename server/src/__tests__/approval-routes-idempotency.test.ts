import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));

const mockIssuesService = vi.hoisted(() => ({
  addComment: vi.fn(async () => ({ id: "comment-1" })),
  getById: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockInstructionRuleService = vi.hoisted(() => ({
  create: vi.fn(),
  resubmit: vi.fn(),
}));
const mockDbSelect = vi.hoisted(() => vi.fn());
const mockDb = vi.hoisted(() => ({ select: mockDbSelect }));

const mockAppendChatResult = vi.hoisted(() =>
  vi.fn(async () => ({ messageId: "msg-1" })),
);

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    approvalService: () => mockApprovalService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    issueService: () => mockIssuesService,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
  }));
  // executeDraftedApproval (in tool-draft-gate.js) imports approvalService
  // directly from ./approvals.js, bypassing the services barrel — mock the
  // direct path too so the route's re-dispatch path uses the same fakes.
  vi.doMock("../services/approvals.js", () => ({
    approvalService: () => mockApprovalService,
  }));
  // Stub the chat-session wake helper so we can assert it was (or wasn't)
  // called without standing up the full chat service or a database.
  vi.doMock("../services/chat.js", () => ({
    appendApprovedDraftResultToChatSession: mockAppendChatResult,
  }));
  vi.doMock("../services/instruction-rules.js", () => ({
    instructionRuleService: () => mockInstructionRuleService,
  }));
}

async function createApp(
  actorOverrides: Record<string, unknown> = {},
  routeOptions: Record<string, unknown> = {},
) {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
      ...actorOverrides,
    };
    next();
  });
  app.use("/api", approvalRoutes(mockDb as any, routeOptions as any));
  app.use(errorHandler);
  return app;
}

async function createAgentApp(agentId = "agent-1") {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId,
      companyId: "company-1",
      source: "api_key",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", approvalRoutes(mockDb as any));
  app.use(errorHandler);
  return app;
}

describe("approval routes idempotent retries", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/approvals.js");
    vi.doUnmock("../services/chat.js");
    vi.doUnmock("../services/instruction-rules.js");
    vi.doUnmock("../routes/approvals.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockApprovalService.list.mockReset();
    mockApprovalService.getById.mockReset();
    mockApprovalService.create.mockReset();
    mockApprovalService.approve.mockReset();
    mockApprovalService.reject.mockReset();
    mockApprovalService.requestRevision.mockReset();
    mockApprovalService.resubmit.mockReset();
    mockApprovalService.listComments.mockReset();
    mockApprovalService.addComment.mockReset();
    mockHeartbeatService.wakeup.mockReset();
    mockIssueApprovalService.listIssuesForApproval.mockReset();
    mockIssueApprovalService.linkManyForApproval.mockReset();
    mockSecretService.normalizeHireApprovalPayloadForPersistence.mockReset();
    mockLogActivity.mockReset();
    mockIssuesService.getById.mockReset();
    mockIssuesService.getById.mockImplementation(async (id: string) => ({ id, companyId: "company-1" }));
    mockInstructionRuleService.create.mockReset();
    mockInstructionRuleService.resubmit.mockReset();
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-1" }]);
    mockLogActivity.mockResolvedValue(undefined);
    mockAppendChatResult.mockReset();
    mockAppendChatResult.mockResolvedValue({ messageId: "msg-1" });
    mockDbSelect.mockReset();
  });

  it("lets only the corrected agent draft an instruction change and links its source issue", async () => {
    const agentId = "11111111-1111-4111-8111-111111111111";
    const issueId = "22222222-2222-4222-8222-222222222222";
    const commentId = "33333333-3333-4333-8333-333333333333";
    mockDbSelect.mockReturnValue({
      from: () => ({
        innerJoin: () => ({
          where: async () => [{
            commentId,
            commentIntent: "correction",
            commentAuthorUserId: "board-user",
            issueId,
            issueCompanyId: "company-1",
            assigneeAgentId: agentId,
          }],
        }),
      }),
    });
    const payload = {
      version: 1,
      scope: "agent",
      targetAgentId: agentId,
      sourceIssueId: issueId,
      sourceCommentId: commentId,
      rule: "Verify totals before posting.",
    };
    mockInstructionRuleService.create.mockResolvedValue({
      approval: {
        id: "approval-rule-1",
        companyId: "company-1",
        type: "instruction_change",
        status: "pending",
        payload,
        requestedByAgentId: agentId,
      },
      created: true,
    });
    const res = await request(await createAgentApp(agentId))
      .post("/api/companies/company-1/approvals")
      .send({
        type: "instruction_change",
        payload,
        issueIds: ["44444444-4444-4444-8444-444444444444", issueId],
      });
    expect(res.status).toBe(201);
    expect(mockInstructionRuleService.create).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "company-1",
      requestedByAgentId: agentId,
      payload,
      linkedIssueIds: [issueId],
    }));
    expect(mockIssueApprovalService.linkManyForApproval).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("wakes the corrected agent after the instruction service atomically approves the rule", async () => {
    const agentId = "11111111-1111-4111-8111-111111111111";
    const issueId = "22222222-2222-4222-8222-222222222222";
    const commentId = "33333333-3333-4333-8333-333333333333";
    const payload = {
      version: 1,
      scope: "company",
      targetAgentId: agentId,
      sourceIssueId: issueId,
      sourceCommentId: commentId,
      rule: "Verify totals before posting.",
    };
    mockDbSelect.mockReturnValue({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: async () => [{
              intent: "correction",
              authorUserId: "board-user",
              issueCompanyId: "company-1",
              targetCompanyId: "company-1",
            }],
          }),
        }),
      }),
    });
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-rule-1",
      companyId: "company-1",
      type: "instruction_change",
      status: "pending",
      payload,
      requestedByAgentId: agentId,
    });
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-rule-1",
        companyId: "company-1",
        type: "instruction_change",
        status: "approved",
        payload,
        requestedByAgentId: agentId,
      },
      applied: true,
    });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: issueId }]);
    const res = await request(await createApp())
      .post("/api/approvals/approval-rule-1/approve")
      .send({});
    expect(res.status).toBe(200);
    expect(mockApprovalService.approve).toHaveBeenCalledWith(
      "approval-rule-1",
      "user-1",
      undefined,
      {},
    );
    expect(mockIssuesService.addComment).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "approval.requester_wakeup_queued",
    }));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({
        idempotencyKey: "approval:approval-rule-1:requester-wakeup:approved",
      }),
    );
  });

  it("retries a failed instruction approval wake without repeating durable approval effects", async () => {
    const agentId = "11111111-1111-4111-8111-111111111111";
    const issueId = "22222222-2222-4222-8222-222222222222";
    const payload = {
      version: 1,
      scope: "agent",
      targetAgentId: agentId,
      sourceIssueId: issueId,
      sourceCommentId: "33333333-3333-4333-8333-333333333333",
      rule: "Verify totals before posting.",
    };
    const approved = {
      id: "approval-rule-retry",
      companyId: "company-1",
      type: "instruction_change",
      status: "approved",
      payload,
      requestedByAgentId: agentId,
    };
    mockApprovalService.getById.mockResolvedValue(approved);
    mockApprovalService.approve
      .mockResolvedValueOnce({ approval: approved, applied: true })
      .mockResolvedValueOnce({ approval: approved, applied: false });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: issueId }]);
    mockHeartbeatService.wakeup
      .mockRejectedValueOnce(new Error("queue unavailable"))
      .mockResolvedValueOnce({ id: "wake-retry" });
    const app = await createApp();

    await request(app).post("/api/approvals/approval-rule-retry/approve").send({}).expect(200);
    await request(app).post("/api/approvals/approval-rule-retry/approve").send({}).expect(200);

    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(2);
    expect(mockHeartbeatService.wakeup).toHaveBeenNthCalledWith(
      2,
      agentId,
      expect.objectContaining({
        idempotencyKey: "approval:approval-rule-retry:requester-wakeup:approved",
      }),
    );
    expect(mockIssuesService.addComment).not.toHaveBeenCalled();
  });

  it("retries rejected instruction wakes with one delivery key and the original decision actor", async () => {
    const rejected = {
      id: "approval-rule-rejected",
      companyId: "company-1",
      type: "instruction_change",
      status: "rejected",
      decidedByUserId: "original-board",
      requestedByAgentId: "11111111-1111-4111-8111-111111111111",
      payload: {
        version: 1, scope: "agent",
        targetAgentId: "11111111-1111-4111-8111-111111111111",
        sourceIssueId: "22222222-2222-4222-8222-222222222222",
        sourceCommentId: "33333333-3333-4333-8333-333333333333",
        rule: "Verify totals before posting.",
      },
    };
    mockApprovalService.getById.mockResolvedValue(rejected);
    mockApprovalService.reject
      .mockResolvedValueOnce({ approval: rejected, applied: true })
      .mockResolvedValue({ approval: rejected, applied: false });
    mockHeartbeatService.wakeup.mockRejectedValueOnce(new Error("queue unavailable"))
      .mockResolvedValue({ id: "wake-retry" });
    const app = await createApp();

    for (let attempt = 0; attempt < 3; attempt++) {
      await request(app).post("/api/approvals/approval-rule-rejected/reject").send({}).expect(200);
    }
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(3);
    for (const [agentId, options] of mockHeartbeatService.wakeup.mock.calls) {
      expect(agentId).toBe(rejected.requestedByAgentId);
      expect(options).toMatchObject({
        idempotencyKey: "approval:approval-rule-rejected:requester-wakeup:rejected",
        requestedByActorId: "original-board",
        reason: "approval_rejected",
        payload: { approvalId: rejected.id, approvalStatus: "rejected", issueId: rejected.payload.sourceIssueId },
      });
    }
    expect(mockIssuesService.addComment).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("retries instruction revision wakes with the original note and one delivery key", async () => {
    const agentId = "11111111-1111-4111-8111-111111111111";
    const issueId = "22222222-2222-4222-8222-222222222222";
    const commentId = "33333333-3333-4333-8333-333333333333";
    const revised = {
      id: "approval-rule-revision",
      companyId: "company-1",
      type: "instruction_change",
      status: "revision_requested",
      decidedByUserId: "original-board",
      decisionNote: "State when this check applies.",
      decidedAt: new Date("2026-10-15T10:00:00.000Z"),
      updatedAt: new Date("2026-10-15T10:00:00.000Z"),
      requestedByAgentId: agentId,
      payload: {
        version: 1,
        scope: "agent",
        targetAgentId: agentId,
        sourceIssueId: issueId,
        sourceCommentId: commentId,
        rule: "Verify totals before posting.",
      },
    };
    mockApprovalService.getById.mockResolvedValue(revised);
    mockApprovalService.requestRevision
      .mockResolvedValueOnce({ approval: revised, applied: true })
      .mockResolvedValueOnce({ approval: revised, applied: false });
    mockHeartbeatService.wakeup
      .mockRejectedValueOnce(new Error("queue unavailable"))
      .mockResolvedValueOnce({ id: "wake-retry" });
    const app = await createApp();

    await request(app)
      .post(`/api/approvals/${revised.id}/request-revision`)
      .send({ decisionNote: revised.decisionNote })
      .expect(200);
    await request(app)
      .post(`/api/approvals/${revised.id}/request-revision`)
      .send({ decisionNote: "A different retry note must not replace the decision" })
      .expect(200);

    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(2);
    for (const [wokenAgentId, options] of mockHeartbeatService.wakeup.mock.calls) {
      expect(wokenAgentId).toBe(agentId);
      expect(options).toMatchObject({
        idempotencyKey: `approval:${revised.id}:requester-wakeup:revision-requested:2026-10-15T10:00:00.000Z`,
        requestedByActorId: "original-board",
        reason: "approval_revision_requested",
        payload: {
          approvalId: revised.id,
          approvalStatus: "revision_requested",
          decisionNote: revised.decisionNote,
          revisionCycle: "2026-10-15T10:00:00.000Z",
          issueId,
          sourceIssueId: issueId,
          sourceCommentId: commentId,
          targetAgentId: agentId,
          scope: "agent",
          rule: revised.payload.rule,
        },
        contextSnapshot: {
          source: "approval.revision_requested",
          decisionNote: revised.decisionNote,
          issueId,
          taskId: issueId,
          sourceIssueId: issueId,
          sourceCommentId: commentId,
          revisionCycle: "2026-10-15T10:00:00.000Z",
          wakeReason: "approval_revision_requested",
        },
      });
    }
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      actorId: "original-board",
      action: "approval.revision_requested",
    }));
  });

  it.each([
    { label: "missing", body: {} },
    { label: "null", body: { decisionNote: null } },
    { label: "blank", body: { decisionNote: "   " } },
  ])("requires a revision note for instruction changes when it is $label", async ({ body }) => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-rule-note",
      companyId: "company-1",
      type: "instruction_change",
      status: "pending",
      requestedByAgentId: "11111111-1111-4111-8111-111111111111",
      payload: {},
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-rule-note/request-revision")
      .send(body);

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "A revision note is required for instruction changes" });
    expect(mockApprovalService.requestRevision).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("uses a new delivery key for a later revision cycle of the same instruction approval", async () => {
    const agentId = "11111111-1111-4111-8111-111111111111";
    const issueId = "22222222-2222-4222-8222-222222222222";
    const payload = {
      version: 1,
      scope: "agent",
      targetAgentId: agentId,
      sourceIssueId: issueId,
      sourceCommentId: "33333333-3333-4333-8333-333333333333",
      rule: "Verify totals before posting.",
    };
    const pending = {
      id: "approval-rule-cycles",
      companyId: "company-1",
      type: "instruction_change",
      status: "pending",
      requestedByAgentId: agentId,
      payload,
    };
    mockApprovalService.getById.mockResolvedValue(pending);
    mockApprovalService.requestRevision
      .mockResolvedValueOnce({
        approval: { ...pending, status: "revision_requested", decisionNote: "First revision.", decidedByUserId: "user-1", decidedAt: new Date("2026-10-15T10:00:00.000Z"), updatedAt: new Date("2026-10-15T10:00:00.000Z") },
        applied: true,
      })
      .mockResolvedValueOnce({
        approval: { ...pending, status: "revision_requested", decisionNote: "Second revision.", decidedByUserId: "user-1", decidedAt: new Date("2026-10-15T11:00:00.000Z"), updatedAt: new Date("2026-10-15T11:00:00.000Z") },
        applied: true,
      });
    const app = await createApp();

    await request(app).post(`/api/approvals/${pending.id}/request-revision`).send({ decisionNote: "First revision." }).expect(200);
    await request(app).post(`/api/approvals/${pending.id}/request-revision`).send({ decisionNote: "Second revision." }).expect(200);

    expect(mockHeartbeatService.wakeup.mock.calls.map(([, options]) => options.idempotencyKey)).toEqual([
      `approval:${pending.id}:requester-wakeup:revision-requested:2026-10-15T10:00:00.000Z`,
      `approval:${pending.id}:requester-wakeup:revision-requested:2026-10-15T11:00:00.000Z`,
    ]);
  });

  it("wakes the requester without a task when the rejected instruction source issue was deleted", async () => {
    const rejected = {
      id: "approval-rule-deleted-source", companyId: "company-1",
      type: "instruction_change", status: "rejected", decidedByUserId: "board",
      requestedByAgentId: "11111111-1111-4111-8111-111111111111",
      payload: {
        version: 1, scope: "agent", rule: "Verify totals.",
        targetAgentId: "11111111-1111-4111-8111-111111111111",
        sourceIssueId: "22222222-2222-4222-8222-222222222222",
        sourceCommentId: "33333333-3333-4333-8333-333333333333",
      },
    };
    mockApprovalService.getById.mockResolvedValue(rejected);
    mockApprovalService.reject.mockResolvedValue({ approval: rejected, applied: false });
    mockIssuesService.getById.mockResolvedValue(null);
    await request(await createApp()).post(`/api/approvals/${rejected.id}/reject`).send({}).expect(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(rejected.requestedByAgentId, expect.objectContaining({
      idempotencyKey: `approval:${rejected.id}:requester-wakeup:rejected`,
      payload: { approvalId: rejected.id, approvalStatus: "rejected", issueId: null },
      contextSnapshot: expect.objectContaining({ issueId: null, taskId: null }),
    }));
  });

  it("does not emit duplicate approval side effects when approve is already resolved", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "approved",
      payload: {},
      requestedByAgentId: "agent-1",
    });
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-1",
        companyId: "company-1",
        type: "hire_agent",
        status: "approved",
        payload: {},
        requestedByAgentId: "agent-1",
      },
      applied: false,
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-1/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(mockIssueApprovalService.listIssuesForApproval).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("does not emit duplicate rejection logs when reject is already resolved", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "rejected",
      payload: {},
    });
    mockApprovalService.reject.mockResolvedValue({
      approval: {
        id: "approval-1",
        companyId: "company-1",
        type: "hire_agent",
        status: "rejected",
        payload: {},
      },
      applied: false,
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-1/reject")
      .send({});

    expect(res.status).toBe(200);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("logs a refused unclassified write when the board rejects its draft", async () => {
    const pending = {
      id: "approval-action-rejected",
      companyId: "company-1",
      type: "outbound_tool_draft",
      status: "pending",
      payload: {
        toolName: "files:replace",
        actionType: null,
        actionPolicySource: "unclassified",
        runId: "run-1",
      },
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
    };
    mockApprovalService.getById.mockResolvedValue(pending);
    mockApprovalService.reject.mockResolvedValue({
      approval: { ...pending, status: "rejected" },
      applied: true,
    });

    const res = await request(await createApp())
      .post(`/api/approvals/${pending.id}/reject`)
      .send({});

    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "agent_action.refused",
        agentId: "agent-1",
        details: expect.objectContaining({ actionType: null, policySource: "unclassified" }),
      }),
    );
  });

  it("rejects approval decisions for companies outside the caller scope", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-2",
      companyId: "company-2",
      type: "hire_agent",
      status: "pending",
      payload: {},
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-2/approve")
      .send({});

    expect(res.status).toBe(403);
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
  });

  it("rejects approval revision requests for companies outside the caller scope", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-3",
      companyId: "company-2",
      type: "hire_agent",
      status: "pending",
      payload: {},
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-3/request-revision")
      .send({ decisionNote: "Need changes" });

    expect(res.status).toBe(403);
    expect(mockApprovalService.requestRevision).not.toHaveBeenCalled();
  });

  it("derives approval attribution from the authenticated actor on approve", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-4",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: {},
      requestedByAgentId: null,
    });
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-4",
        companyId: "company-1",
        type: "hire_agent",
        status: "approved",
        payload: {},
        requestedByAgentId: null,
      },
      applied: true,
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-4/approve")
      .send({ decidedByUserId: "forged-user", decisionNote: "ship it" });

    expect(res.status).toBe(200);
    expect(mockApprovalService.approve).toHaveBeenCalledWith("approval-4", "user-1", "ship it", {});
  });

  it("derives approval attribution from the authenticated actor on reject", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-5",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: {},
    });
    mockApprovalService.reject.mockResolvedValue({
      approval: {
        id: "approval-5",
        companyId: "company-1",
        type: "hire_agent",
        status: "rejected",
        payload: {},
      },
      applied: true,
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-5/reject")
      .send({ decidedByUserId: "forged-user", decisionNote: "not now" });

    expect(res.status).toBe(200);
    expect(mockApprovalService.reject).toHaveBeenCalledWith("approval-5", "user-1", "not now", {});
  });

  it("derives approval attribution from the authenticated actor on request revision", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-6",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: {},
    });
    mockApprovalService.requestRevision.mockResolvedValue({
      approval: {
        id: "approval-6",
        companyId: "company-1",
        type: "hire_agent",
        status: "revision_requested",
        payload: {},
      },
      applied: true,
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-6/request-revision")
      .send({ decidedByUserId: "forged-user", decisionNote: "Need changes" });

    expect(res.status).toBe(200);
    expect(mockApprovalService.requestRevision).toHaveBeenCalledWith(
      "approval-6",
      "user-1",
      "Need changes",
    );
  });

  it("lets agents create generic issue-linked board approval requests", async () => {
    mockApprovalService.create.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "request_board_approval",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      status: "pending",
      payload: { title: "Approve hosting spend" },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-04-06T00:00:00.000Z"),
      updatedAt: new Date("2026-04-06T00:00:00.000Z"),
    });

    const res = await request(await createAgentApp())
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        issueIds: ["00000000-0000-0000-0000-000000000001"],
        payload: { title: "Approve hosting spend" },
      });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(res.body).toMatchObject({
      companyId: "company-1",
      type: "request_board_approval",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      status: "pending",
    });
    expect(mockSecretService.normalizeHireApprovalPayloadForPersistence).not.toHaveBeenCalled();
    expect(mockIssueApprovalService.linkManyForApproval).toHaveBeenCalledWith(
      "approval-1",
      ["00000000-0000-0000-0000-000000000001"],
      { agentId: "agent-1", userId: null },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        actorType: "agent",
        actorId: "agent-1",
        action: "approval.created",
      }),
    );
  });

  it("rejects executable outbound drafts created through the generic approval API", async () => {
    const res = await request(await createAgentApp())
      .post("/api/companies/company-1/approvals")
      .send({
        type: "outbound_tool_draft",
        payload: {
          toolName: "email-tools:email_send",
          parameters: { to: "customer@example.com", body: "Forged" },
          summary: "Harmless-looking summary",
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("action checkpoint");
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("rejects payload replacement when an outbound draft is resubmitted", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-draft-revision",
      companyId: "company-1",
      type: "outbound_tool_draft",
      status: "revision_requested",
      requestedByAgentId: "agent-1",
      payload: {
        toolName: "email-tools:email_send",
        parameters: { to: "customer@example.com", body: "Original" },
        actionType: "send_message",
        actionPolicySource: "company",
      },
    });

    const res = await request(await createAgentApp())
      .post("/api/approvals/approval-draft-revision/resubmit")
      .send({
        payload: {
          toolName: "email-tools:email_send",
          parameters: { to: "attacker@example.com", body: "Replacement" },
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("cannot be revised");
    expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
  });

  it("rejects revision requests for immutable outbound drafts", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-draft-pending",
      companyId: "company-1",
      type: "outbound_tool_draft",
      status: "pending",
      requestedByAgentId: "agent-1",
      payload: { toolName: "email-tools:email_send" },
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-draft-pending/request-revision")
      .send({ decisionNote: "Change the recipient" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("cannot be revised");
    expect(mockApprovalService.requestRevision).not.toHaveBeenCalled();
  });

  it("re-dispatches an approved outbound_tool_draft with bypassDraftGate so the gate does not loop", async () => {
    const draftedApproval = {
      id: "approval-loop",
      companyId: "company-1",
      type: "outbound_tool_draft",
      status: "approved",
      payload: {
        toolName: "3cx-tools:pbx_click_to_call",
        parameters: { toNumber: "+15555550199", fromExtension: "200" },
        agentId: null,
        runId: null,
      },
      requestedByAgentId: null,
      requestedByUserId: "user-1",
    };
    mockApprovalService.getById.mockResolvedValue(draftedApproval);
    mockApprovalService.approve.mockResolvedValue({
      approval: draftedApproval,
      applied: true,
    });
    const executeTool = vi.fn().mockResolvedValue({
      pluginId: "3cx-tools",
      toolName: "3cx-tools:pbx_click_to_call",
      result: { content: "called" },
    });
    const dispatcher = { executeTool };

    const res = await request(
      await createApp({}, { getToolDispatcher: () => dispatcher }),
    )
      .post("/api/approvals/approval-loop/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith(
      "3cx-tools:pbx_click_to_call",
      { toNumber: "+15555550199", fromExtension: "200" },
      expect.any(Object),
      { bypassDraftGate: true, approvedDraftConfirmation: true },
    );
    // No chatSessionId on payload → no chat-session wake.
    expect(mockAppendChatResult).not.toHaveBeenCalled();
  });

  it("records a governed action failure when its approved draft has no dispatcher", async () => {
    const draftedApproval = {
      id: "approval-no-dispatcher",
      companyId: "company-1",
      type: "outbound_tool_draft",
      status: "approved",
      payload: {
        toolName: "email-tools:email_send",
        parameters: { to: "customer@example.com", body: "Hello" },
        agentId: "agent-1",
        runId: null,
        actionType: "send_message",
        actionPolicySource: "company",
      },
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
    };
    mockApprovalService.getById.mockResolvedValue(draftedApproval);
    mockApprovalService.approve.mockResolvedValue({
      approval: draftedApproval,
      applied: true,
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-no-dispatcher/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorType: "user",
        action: "approval.execute_failed",
        entityId: "approval-no-dispatcher",
        details: expect.objectContaining({ reason: "no_tool_dispatcher", ok: false }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorType: "agent",
        actorId: "agent-1",
        action: "agent_action.failed",
        entityId: "approval-no-dispatcher",
        details: expect.objectContaining({
          actionType: "send_message",
          policySource: "company",
          error: "Plugin tools were not available, so the approved call did not run.",
        }),
      }),
    );
  });

  it("records a policy refusal once when an approved draft is blocked before dispatch", async () => {
    const draftedApproval = {
      id: "approval-policy-refused",
      companyId: "company-1",
      type: "outbound_tool_draft",
      status: "approved",
      payload: {
        toolName: "mcp:social:post_comment",
        parameters: { body: "Hello" },
        agentId: "agent-1",
        runId: null,
        actionType: "post_publicly",
        actionPolicySource: "company",
      },
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
    };
    mockApprovalService.getById.mockResolvedValue(draftedApproval);
    mockApprovalService.approve.mockResolvedValue({ approval: draftedApproval, applied: true });
    const dispatcher = {
      executeTool: vi.fn().mockRejectedValue(new Error(
        '[EDISABLED] mutation tool "post_comment" is gated by allowMutations',
      )),
    };

    const res = await request(
      await createApp({}, { getToolDispatcher: () => dispatcher }),
    )
      .post("/api/approvals/approval-policy-refused/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "agent_action.refused",
        entityId: "approval-policy-refused",
      }),
    );
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "agent_action.failed",
        entityId: "approval-policy-refused",
      }),
    );
  });

  it("records a returned plugin mutation-switch refusal after approval", async () => {
    const draftedApproval = {
      id: "approval-result-refused",
      companyId: "company-1",
      type: "outbound_tool_draft",
      status: "approved",
      payload: {
        toolName: "slack-tools:slack_update_message",
        parameters: { channelId: "C1", ts: "1", text: "Updated" },
        agentId: "agent-1",
        runId: null,
        actionType: "send_message",
        actionPolicySource: "company",
      },
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
    };
    mockApprovalService.getById.mockResolvedValue(draftedApproval);
    mockApprovalService.approve.mockResolvedValue({ approval: draftedApproval, applied: true });
    const dispatcher = {
      executeTool: vi.fn().mockResolvedValue({
        pluginId: "slack-tools",
        toolName: "slack_update_message",
        result: { error: "[EDISABLED] Mutations are disabled" },
      }),
    };

    const res = await request(
      await createApp({}, { getToolDispatcher: () => dispatcher }),
    )
      .post("/api/approvals/approval-result-refused/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "agent_action.refused",
        entityId: "approval-result-refused",
      }),
    );
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "agent_action.failed",
        entityId: "approval-result-refused",
      }),
    );
  });

  it("refuses a pending action after its requesting agent was deleted", async () => {
    const deletedAgentId = "11111111-1111-4111-8111-111111111111";
    const draftedApproval = {
      id: "approval-deleted-agent",
      companyId: "company-1",
      type: "outbound_tool_draft",
      status: "approved",
      payload: {
        toolName: "email-tools:email_send",
        parameters: { to: "customer@example.com", body: "Hello" },
        agentId: deletedAgentId,
        runId: "22222222-2222-4222-8222-222222222222",
        actionType: "send_message",
        actionPolicySource: "company",
      },
      requestedByAgentId: null,
      requestedByUserId: null,
    };
    mockApprovalService.getById.mockResolvedValue(draftedApproval);
    mockApprovalService.approve.mockResolvedValue({ approval: draftedApproval, applied: true });
    const dispatcher = { executeTool: vi.fn() };

    const res = await request(
      await createApp({}, { getToolDispatcher: () => dispatcher }),
    )
      .post("/api/approvals/approval-deleted-agent/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(dispatcher.executeTool).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorId: deletedAgentId,
        agentId: null,
        action: "agent_action.refused",
        entityId: "approval-deleted-agent",
      }),
    );
  });

  it("audits rejection after the requesting agent was deleted", async () => {
    const deletedAgentId = "11111111-1111-4111-8111-111111111111";
    const draftedApproval = {
      id: "rejection-deleted-agent",
      companyId: "company-1",
      type: "outbound_tool_draft",
      status: "rejected",
      payload: {
        toolName: "email-tools:email_send",
        agentId: deletedAgentId,
        runId: "22222222-2222-4222-8222-222222222222",
        actionType: "send_message",
        actionPolicySource: "company",
      },
      requestedByAgentId: null,
      requestedByUserId: null,
    };
    mockApprovalService.getById.mockResolvedValue(draftedApproval);
    mockApprovalService.reject.mockResolvedValue({ approval: draftedApproval, applied: true });

    const res = await request(await createApp())
      .post("/api/approvals/rejection-deleted-agent/reject")
      .send({});

    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorId: deletedAgentId,
        agentId: null,
        action: "agent_action.refused",
        entityId: "rejection-deleted-agent",
      }),
    );
  });

  it("returns an explicit uncertain failure when an approved action outcome cannot be audited", async () => {
    const draftedApproval = {
      id: "approval-audit-failed",
      companyId: "company-1",
      type: "outbound_tool_draft",
      status: "approved",
      payload: {
        toolName: "email-tools:email_send",
        parameters: { to: "customer@example.com", body: "Hello" },
        actionType: "send_message",
        actionPolicySource: "company",
      },
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
    };
    mockApprovalService.getById.mockResolvedValue(draftedApproval);
    mockApprovalService.approve.mockResolvedValue({ approval: draftedApproval, applied: true });
    mockLogActivity.mockImplementation(async (_db, event) => {
      if (event.action === "agent_action.allowed") throw new Error("activity store unavailable");
    });
    const dispatcher = {
      executeTool: vi.fn().mockResolvedValue({
        pluginId: "email-tools",
        toolName: "email-tools:email_send",
        result: { content: "sent" },
      }),
    };

    const res = await request(await createApp({}, { getToolDispatcher: () => dispatcher }))
      .post("/api/approvals/approval-audit-failed/approve")
      .send({});

    expect(res.status).toBe(503);
    expect(res.body.error).toContain("may have completed");
  });

  it("repairs a missing approved action audit on an idempotent retry without rerunning the action", async () => {
    const draftedApproval = {
      id: "approval-audit-retry",
      companyId: "company-1",
      type: "outbound_tool_draft",
      status: "approved",
      decidedByUserId: "user-1",
      payload: {
        toolName: "email-tools:email_send",
        parameters: { to: "customer@example.com", body: "Hello" },
        actionType: "send_message",
        actionPolicySource: "company",
      },
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
    };
    mockApprovalService.getById.mockResolvedValue(draftedApproval);
    mockApprovalService.approve
      .mockResolvedValueOnce({ approval: draftedApproval, applied: true })
      .mockResolvedValueOnce({ approval: draftedApproval, applied: false });
    let failAudit = true;
    mockLogActivity.mockImplementation(async (_db, event) => {
      if (event.action === "agent_action.allowed" && failAudit) {
        failAudit = false;
        throw new Error("activity store unavailable");
      }
    });
    const dispatcher = {
      executeTool: vi.fn().mockResolvedValue({
        pluginId: "email-tools",
        toolName: "email-tools:email_send",
        result: { content: "sent" },
      }),
    };
    const findActionAudit = vi.fn().mockResolvedValue([
      { action: "approval.executed", details: { ok: true } },
    ]);
    const app = await createApp({}, { getToolDispatcher: () => dispatcher, findActionAudit });

    await request(app).post("/api/approvals/approval-audit-retry/approve").send({}).expect(503);
    await request(app).post("/api/approvals/approval-audit-retry/approve").send({}).expect(200);

    expect(dispatcher.executeTool).toHaveBeenCalledTimes(1);
    expect(findActionAudit).toHaveBeenCalledWith("company-1", "approval-audit-retry");
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "agent_action.allowed",
      details: expect.objectContaining({ recoveredOnRetry: true }),
    }));
  });

  it("repairs a missing approval execution receipt independently of the action outcome", async () => {
    const draftedApproval = {
      id: "approval-receipt-retry",
      companyId: "company-1",
      type: "outbound_tool_draft",
      status: "approved",
      decidedByUserId: "user-1",
      payload: {
        toolName: "email-tools:email_send",
        actionType: "send_message",
        actionPolicySource: "company",
      },
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
    };
    mockApprovalService.getById.mockResolvedValue(draftedApproval);
    mockApprovalService.approve.mockResolvedValue({ approval: draftedApproval, applied: false });
    const findActionAudit = vi.fn().mockResolvedValue([{
      action: "agent_action.refused",
      details: { actionType: "send_message" },
    }]);

    await request(await createApp({}, { findActionAudit }))
      .post("/api/approvals/approval-receipt-retry/approve")
      .send({})
      .expect(200);

    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "approval.execute_failed",
      details: expect.objectContaining({ outcome: "refused", recoveredOnRetry: true }),
    }));
    expect(mockLogActivity).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "agent_action.refused",
    }));
  });

  it("records an uncertain failure when an approved retry has no execution receipt", async () => {
    const draftedApproval = {
      id: "approval-audit-no-receipt",
      companyId: "company-1",
      type: "outbound_tool_draft",
      status: "approved",
      decidedByUserId: "user-1",
      decidedAt: "2020-01-01T00:00:00.000Z",
      payload: {
        toolName: "email-tools:email_send",
        actionType: "send_message",
        actionPolicySource: "company",
      },
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
    };
    mockApprovalService.getById.mockResolvedValue(draftedApproval);
    mockApprovalService.approve.mockResolvedValue({ approval: draftedApproval, applied: false });
    const dispatcher = { executeTool: vi.fn() };
    const findActionAudit = vi.fn().mockResolvedValue([{
      action: "approval.execution_started",
      details: { leaseExpiresAt: "2020-01-01T00:10:00.000Z" },
    }]);

    await request(await createApp({}, { getToolDispatcher: () => dispatcher, findActionAudit }))
      .post("/api/approvals/approval-audit-no-receipt/approve")
      .send({})
      .expect(200);

    expect(dispatcher.executeTool).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "agent_action.failed",
      details: expect.objectContaining({
        recoveredOnRetry: true,
        outcomeUncertain: true,
      }),
    }));
  });

  it("does not finalize a receipt-free retry while the first approval handler may still be running", async () => {
    const draftedApproval = {
      id: "approval-audit-in-progress",
      companyId: "company-1",
      type: "outbound_tool_draft",
      status: "approved",
      decidedByUserId: "user-1",
      decidedAt: new Date().toISOString(),
      payload: {
        toolName: "email-tools:email_send",
        actionType: "send_message",
        actionPolicySource: "company",
      },
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
    };
    mockApprovalService.getById.mockResolvedValue(draftedApproval);
    mockApprovalService.approve.mockResolvedValue({ approval: draftedApproval, applied: false });
    const findActionAudit = vi.fn().mockResolvedValue([{
      action: "approval.execution_started",
      details: { leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() },
    }]);

    await request(await createApp({}, { findActionAudit }))
      .post("/api/approvals/approval-audit-in-progress/approve")
      .send({})
      .expect(200);

    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "agent_action.failed" }),
    );
  });

  it("does not finalize a retry during the gap before the execution lease is recorded", async () => {
    const draftedApproval = {
      id: "approval-audit-before-start",
      companyId: "company-1",
      type: "outbound_tool_draft",
      status: "approved",
      decidedByUserId: "user-1",
      decidedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      payload: {
        toolName: "email-tools:email_send",
        actionType: "send_message",
        actionPolicySource: "company",
      },
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
    };
    mockApprovalService.getById.mockResolvedValue(draftedApproval);
    mockApprovalService.approve.mockResolvedValue({ approval: draftedApproval, applied: false });
    const findActionAudit = vi.fn().mockResolvedValue([]);

    await request(await createApp({}, { findActionAudit }))
      .post("/api/approvals/approval-audit-before-start/approve")
      .send({})
      .expect(200);

    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "agent_action.failed" }),
    );
  });

  it("does not run an approved action when its durable execution start cannot be recorded", async () => {
    const draftedApproval = {
      id: "approval-start-audit-failed",
      companyId: "company-1",
      type: "outbound_tool_draft",
      status: "approved",
      payload: {
        toolName: "email-tools:email_send",
        parameters: { to: "customer@example.com", body: "Hello" },
        actionType: "send_message",
        actionPolicySource: "company",
      },
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
    };
    mockApprovalService.getById.mockResolvedValue(draftedApproval);
    mockApprovalService.approve.mockResolvedValue({ approval: draftedApproval, applied: true });
    mockLogActivity.mockImplementation(async (_db, event) => {
      if (event.action === "approval.execution_started") throw new Error("activity store unavailable");
    });
    const dispatcher = { executeTool: vi.fn() };

    const res = await request(await createApp({}, { getToolDispatcher: () => dispatcher }))
      .post("/api/approvals/approval-start-audit-failed/approve")
      .send({});

    expect(res.status).toBe(503);
    expect(res.body.error).toContain("action was not run");
    expect(dispatcher.executeTool).not.toHaveBeenCalled();
  });

  it("fails explicitly when a rejected action outcome cannot be audited", async () => {
    const draftedApproval = {
      id: "rejection-audit-failed",
      companyId: "company-1",
      type: "outbound_tool_draft",
      status: "rejected",
      payload: {
        toolName: "email-tools:email_send",
        actionType: "send_message",
        actionPolicySource: "company",
      },
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
    };
    mockApprovalService.getById.mockResolvedValue(draftedApproval);
    mockApprovalService.reject.mockResolvedValue({ approval: draftedApproval, applied: true });
    mockLogActivity.mockImplementation(async (_db, event) => {
      if (event.action === "agent_action.refused") throw new Error("activity store unavailable");
    });

    const res = await request(await createApp())
      .post("/api/approvals/rejection-audit-failed/reject")
      .send({});

    expect(res.status).toBe(503);
    expect(res.body.error).toContain("audit record is missing");
  });

  it("repairs a missing refused action audit on an idempotent retry", async () => {
    const draftedApproval = {
      id: "rejection-audit-retry",
      companyId: "company-1",
      type: "outbound_tool_draft",
      status: "rejected",
      decidedByUserId: "user-1",
      payload: {
        toolName: "email-tools:email_send",
        actionType: "send_message",
        actionPolicySource: "company",
      },
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
    };
    mockApprovalService.getById.mockResolvedValue(draftedApproval);
    mockApprovalService.reject
      .mockResolvedValueOnce({ approval: draftedApproval, applied: true })
      .mockResolvedValueOnce({ approval: draftedApproval, applied: false });
    let failAudit = true;
    mockLogActivity.mockImplementation(async (_db, event) => {
      if (event.action === "agent_action.refused" && failAudit) {
        failAudit = false;
        throw new Error("activity store unavailable");
      }
    });
    const findActionAudit = vi.fn().mockResolvedValue([]);
    const app = await createApp({}, { findActionAudit });

    await request(app).post("/api/approvals/rejection-audit-retry/reject").send({}).expect(503);
    await request(app).post("/api/approvals/rejection-audit-retry/reject").send({}).expect(200);

    expect(findActionAudit).toHaveBeenCalledWith("company-1", "rejection-audit-retry");
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "agent_action.refused",
      details: expect.objectContaining({ recoveredOnRetry: true }),
    }));
  });

  it("appends a chat-session wake message when an approved draft carries chatSessionId", async () => {
    const draftedApproval = {
      id: "approval-clippy",
      companyId: "company-1",
      type: "outbound_tool_draft",
      status: "approved",
      payload: {
        toolName: "3cx-tools:pbx_click_to_call",
        parameters: { toNumber: "+15555550199", fromExtension: "200" },
        summary: "to +15555550199",
        agentId: "clippy:user-1",
        runId: null,
        chatSessionId: "session-abc",
      },
      requestedByAgentId: null,
      requestedByUserId: "user-1",
    };
    mockApprovalService.getById.mockResolvedValue(draftedApproval);
    mockApprovalService.approve.mockResolvedValue({
      approval: draftedApproval,
      applied: true,
    });
    const executeTool = vi.fn().mockResolvedValue({
      pluginId: "3cx-tools",
      toolName: "3cx-tools:pbx_click_to_call",
      result: { content: "call dispatched, ringing extension 200" },
    });
    const dispatcher = { executeTool };

    const res = await request(
      await createApp({}, { getToolDispatcher: () => dispatcher }),
    )
      .post("/api/approvals/approval-clippy/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(mockAppendChatResult).toHaveBeenCalledTimes(1);
    expect(mockAppendChatResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        chatSessionId: "session-abc",
        toolName: "3cx-tools:pbx_click_to_call",
        summary: "to +15555550199",
        outcome: { ok: true, content: "call dispatched, ringing extension 200" },
      }),
    );
  });

  it("appends a wake message with ok:false when the underlying tool execution returns an error", async () => {
    const draftedApproval = {
      id: "approval-clippy-err",
      companyId: "company-1",
      type: "outbound_tool_draft",
      status: "approved",
      payload: {
        toolName: "3cx-tools:pbx_click_to_call",
        parameters: { toNumber: "+15555550199", fromExtension: "200" },
        summary: "to +15555550199",
        agentId: "clippy:user-1",
        runId: null,
        chatSessionId: "session-xyz",
      },
      requestedByAgentId: null,
      requestedByUserId: "user-1",
    };
    mockApprovalService.getById.mockResolvedValue(draftedApproval);
    mockApprovalService.approve.mockResolvedValue({
      approval: draftedApproval,
      applied: true,
    });
    const executeTool = vi.fn().mockResolvedValue({
      pluginId: "3cx-tools",
      toolName: "3cx-tools:pbx_click_to_call",
      result: { error: "PBX rejected: extension 200 is offline" },
    });
    const dispatcher = { executeTool };

    const res = await request(
      await createApp({}, { getToolDispatcher: () => dispatcher }),
    )
      .post("/api/approvals/approval-clippy-err/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(mockAppendChatResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        outcome: { ok: false, error: "PBX rejected: extension 200 is offline" },
      }),
    );
  });

  it("says on the issue that the approved message went out, and tells the agent so", async () => {
    // The bug this covers: approving a Slack draft sent the message and left
    // no trace of it on the issue it came from, so the operator could not
    // tell it had happened and the agent went on believing it was pending.
    const draftedApproval = {
      id: "approval-receipt-ok",
      companyId: "company-1",
      type: "outbound_tool_draft",
      status: "approved",
      payload: {
        toolName: "slack-tools:slack_send_dm",
        parameters: { userId: "U123", text: "Is this domain still live?" },
        summary: '— "Is this domain still live?"',
        agentId: "agent-uuid-1",
        runId: "run-1",
        chatSessionId: "heartbeat:run-1",
        actionType: "send_message",
        actionPolicySource: "company",
      },
      requestedByAgentId: "agent-uuid-1",
      requestedByUserId: null,
    };
    mockApprovalService.getById.mockResolvedValue(draftedApproval);
    mockApprovalService.approve.mockResolvedValue({
      approval: draftedApproval,
      applied: true,
    });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([
      { id: "issue-1", companyId: "company-1" },
    ]);
    const dispatcher = {
      executeTool: vi.fn().mockResolvedValue({
        pluginId: "slack-tools",
        toolName: "slack-tools:slack_send_dm",
        result: { content: "sent" },
      }),
    };

    const res = await request(
      await createApp({}, { getToolDispatcher: () => dispatcher }),
    )
      .post("/api/approvals/approval-receipt-ok/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(mockIssuesService.addComment).toHaveBeenCalledTimes(1);
    const [issueId, body] = mockIssuesService.addComment.mock.calls[0];
    expect(issueId).toBe("issue-1");
    expect(body).toContain("Sent.");
    expect(body).toContain("slack-tools:slack_send_dm");

    // And the wake carries the outcome, not just "approved" — which is what
    // left the agent unable to tell a sent message from a pending one.
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "agent-uuid-1",
      expect.objectContaining({
        payload: expect.objectContaining({
          draftExecution: expect.objectContaining({ ok: true }),
        }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "agent_action.allowed",
        details: expect.objectContaining({ actionType: "send_message" }),
      }),
    );
  });

  it("says on the issue when an approved message did not go out", async () => {
    const draftedApproval = {
      id: "approval-receipt-bad",
      companyId: "company-1",
      type: "outbound_tool_draft",
      status: "approved",
      payload: {
        toolName: "slack-tools:slack_send_dm",
        parameters: { userId: "U123", text: "hello" },
        summary: '— "hello"',
        agentId: "agent-uuid-1",
        runId: "run-2",
        actionType: "send_message",
        actionPolicySource: "company",
      },
      requestedByAgentId: "agent-uuid-1",
      requestedByUserId: null,
    };
    mockApprovalService.getById.mockResolvedValue(draftedApproval);
    mockApprovalService.approve.mockResolvedValue({
      approval: draftedApproval,
      applied: true,
    });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([
      { id: "issue-1", companyId: "company-1" },
    ]);
    const dispatcher = {
      executeTool: vi.fn().mockResolvedValue({
        pluginId: "slack-tools",
        toolName: "slack-tools:slack_send_dm",
        result: { error: "slack token expired" },
      }),
    };

    const res = await request(
      await createApp({}, { getToolDispatcher: () => dispatcher }),
    )
      .post("/api/approvals/approval-receipt-bad/approve")
      .send({});

    expect(res.status).toBe(200);
    const [, body] = mockIssuesService.addComment.mock.calls[0];
    expect(body).toContain("Not sent.");
    expect(body).toContain("slack token expired");
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "agent-uuid-1",
      expect.objectContaining({
        payload: expect.objectContaining({
          draftExecution: expect.objectContaining({ ok: false }),
        }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "approval.execute_failed",
        details: expect.objectContaining({ ok: false, hadError: true }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "agent_action.failed",
        details: expect.objectContaining({ actionType: "send_message" }),
      }),
    );
  });

  it("still returns 200 when the issue receipt comment cannot be written", async () => {
    const draftedApproval = {
      id: "approval-receipt-throws",
      companyId: "company-1",
      type: "outbound_tool_draft",
      status: "approved",
      payload: {
        toolName: "slack-tools:slack_send_dm",
        parameters: { userId: "U123", text: "hello" },
        summary: '— "hello"',
        agentId: "agent-uuid-1",
        runId: "run-3",
      },
      requestedByAgentId: null,
      requestedByUserId: null,
    };
    mockApprovalService.getById.mockResolvedValue(draftedApproval);
    mockApprovalService.approve.mockResolvedValue({
      approval: draftedApproval,
      applied: true,
    });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([
      { id: "issue-1", companyId: "company-1" },
    ]);
    mockIssuesService.addComment.mockRejectedValueOnce(new Error("db down"));
    const dispatcher = {
      executeTool: vi.fn().mockResolvedValue({
        pluginId: "slack-tools",
        toolName: "slack-tools:slack_send_dm",
        result: { content: "sent" },
      }),
    };

    const res = await request(
      await createApp({}, { getToolDispatcher: () => dispatcher }),
    )
      .post("/api/approvals/approval-receipt-throws/approve")
      .send({});

    // The message already went. Losing the note about it is not a reason to
    // tell the caller the approval failed.
    expect(res.status).toBe(200);
  });

  it("does not fail the approve response when the chat-session wake append throws", async () => {
    const draftedApproval = {
      id: "approval-clippy-throw",
      companyId: "company-1",
      type: "outbound_tool_draft",
      status: "approved",
      payload: {
        toolName: "3cx-tools:pbx_click_to_call",
        parameters: { toNumber: "+15555550199", fromExtension: "200" },
        summary: "to +15555550199",
        agentId: "clippy:user-1",
        runId: null,
        chatSessionId: "session-broken",
      },
      requestedByAgentId: null,
      requestedByUserId: "user-1",
    };
    mockApprovalService.getById.mockResolvedValue(draftedApproval);
    mockApprovalService.approve.mockResolvedValue({
      approval: draftedApproval,
      applied: true,
    });
    mockAppendChatResult.mockRejectedValueOnce(new Error("db down"));
    const executeTool = vi.fn().mockResolvedValue({
      pluginId: "3cx-tools",
      toolName: "3cx-tools:pbx_click_to_call",
      result: { content: "called" },
    });
    const dispatcher = { executeTool };

    const res = await request(
      await createApp({}, { getToolDispatcher: () => dispatcher }),
    )
      .post("/api/approvals/approval-clippy-throw/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(mockAppendChatResult).toHaveBeenCalledTimes(1);
  });
});
