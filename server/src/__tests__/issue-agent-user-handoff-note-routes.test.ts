import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const ownerAgentId = "33333333-3333-4333-8333-333333333333";
const ownerRunId = "55555555-5555-4555-8555-555555555555";

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
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockDocumentService = vi.hoisted(() => ({
  upsertIssueDocument: vi.fn(),
}));

const mockWorkProductService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));

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
    documentService: () => mockDocumentService,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/work-products.js", () => ({
    workProductService: () => mockWorkProductService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: vi.fn(async () => undefined),
  }));

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    documentService: () => mockDocumentService,
    executionWorkspaceService: () => ({}),
    goalService: () => ({}),
    heartbeatService: () => ({
      wakeup: vi.fn(async () => undefined),
      reportRunActivity: vi.fn(async () => undefined),
      getRun: vi.fn(async () => null),
      getActiveRunForAgent: vi.fn(async () => null),
      cancelRun: vi.fn(async () => null),
    }),
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
        },
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
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => mockWorkProductService,
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
    createdByUserId: "board-user",
    identifier: "PAP-1649",
    title: "Owned active issue",
    executionPolicy: null,
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

function agentActor() {
  return {
    type: "agent",
    agentId: ownerAgentId,
    companyId,
    source: "agent_key",
    runId: ownerRunId,
  };
}

function boardActor() {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [companyId],
    source: "local_implicit",
    isInstanceAdmin: false,
  };
}

const handBackToCreator = { assigneeAgentId: null, assigneeUserId: "board-user", status: "in_review" };

describe("agent handoff to a person requires a note", () => {
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
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAgentService.getById.mockResolvedValue(makeAgent(ownerAgentId, { permissions: { canAssignTasks: true } }));
    mockAgentService.list.mockResolvedValue([makeAgent(ownerAgentId)]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: null });
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue(),
      ...patch,
    }));
    mockIssueService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      ...makeIssue(),
      ...input,
    }));
    mockIssueService.addComment.mockResolvedValue({
      id: "77777777-7777-4777-8777-777777777777",
      issueId,
      companyId,
      body: "comment",
    });
  });

  it("rejects an agent assigning an issue to a person without a comment", async () => {
    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${issueId}`)
      .send(handBackToCreator);

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("must say what they need to do");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects a blank comment on an agent handoff to a person", async () => {
    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ ...handBackToCreator, comment: "   " });

    expect(res.status).toBe(422);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("accepts an agent handoff to a person that says what they need to do", async () => {
    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ ...handBackToCreator, comment: "Please approve the draft in the plan document." });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
    expect(mockIssueService.addComment).toHaveBeenCalled();
  });

  it("does not ask for a note on agent updates that leave the person assignee unchanged", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: null, assigneeUserId: "board-user" }));

    const res = await request(await createApp(agentActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ priority: "low" });

    expect(res.status).not.toBe(422);
  });

  it("lets a board user assign an issue to a person without a comment", async () => {
    const res = await request(await createApp(boardActor()))
      .patch(`/api/issues/${issueId}`)
      .send(handBackToCreator);

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
  });

  it("rejects an agent creating an issue assigned to a person without a description", async () => {
    const res = await request(await createApp(agentActor()))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Sign the vendor form", assigneeUserId: "board-user" });

    expect(res.status).toBe(422);
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("accepts an agent creating an issue for a person with a description", async () => {
    const res = await request(await createApp(agentActor()))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Sign the vendor form",
        description: "Sign the attached form and mark this done; I will send it once signed.",
        assigneeUserId: "board-user",
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalled();
  });
});
