import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getComment: vi.fn(),
  removeComment: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockRedact = vi.hoisted(() => vi.fn());
const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    id: "instance-settings-1",
    general: {
      censorUsernameInLogs: false,
    },
  })),
  listCompanyIds: vi.fn(async () => ["company-1"]),
}));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));

function registerModuleMocks() {
  vi.doMock("../services/comment-redaction.js", () => ({
    redactIssueCommentEverywhere: mockRedact,
  }));
  vi.doMock("../services/run-log-store.js", () => ({
    runLogBaseDir: () => "/tmp/test-run-logs",
    getRunLogStore: () => ({}),
  }));
  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/heartbeat.js", () => ({
    heartbeatService: () => mockHeartbeatService,
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => ({ getById: vi.fn(async () => null) }),
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
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
    workProductService: () => ({}),
  }));
}

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
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    status: "in_progress",
    assigneeAgentId: "22222222-2222-4222-8222-222222222222",
    assigneeUserId: null,
    executionRunId: "run-1",
    identifier: "PAP-1353",
    title: "Queued cancel",
  };
}

function makeComment(overrides: Record<string, unknown> = {}) {
  return {
    id: "comment-1",
    companyId: "company-1",
    issueId: "11111111-1111-4111-8111-111111111111",
    authorAgentId: null,
    authorUserId: "local-board",
    body: "Loan 9000001234 at Example Bank",
    createdAt: new Date("2026-04-11T15:01:00.000Z"),
    updatedAt: new Date("2026-04-11T15:01:00.000Z"),
    ...overrides,
  };
}

const ISSUE = "11111111-1111-4111-8111-111111111111";
const URL = `/api/issues/${ISSUE}/comments/comment-1/redact`;
const counts = {
  comment: 1,
  activityLog: 2,
  runContexts: 1,
  runExcerpts: 0,
  runEvents: 1,
  wakeupRequests: 0,
  reviewDecisions: 0,
  chatMessages: 0,
  runLogFiles: 1,
};

describe.sequential("issue comment redact route", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const m of [
      "../services/access.js",
      "../services/activity-log.js",
      "../services/heartbeat.js",
      "../services/index.js",
      "../services/instance-settings.js",
      "../services/issues.js",
      "../services/comment-redaction.js",
      "../services/run-log-store.js",
      "../routes/issues.js",
      "../routes/authz.js",
      "../middleware/index.js",
    ]) vi.doUnmock(m);
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.getComment.mockResolvedValue(makeComment());
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockLogActivity.mockResolvedValue(undefined);
    mockRedact.mockResolvedValue({
      comment: makeComment({ body: "Loan [redacted …1234] at Example Bank" }),
      replaced: 1,
      counts,
      otherCommentsWithText: 0,
      notReachable: ["database backups made before this redaction"],
    });
  });

  it("redacts for the board, keeping the last 4 by default, and logs no hidden text", async () => {
    const res = await request(await installActor(createApp())).post(URL).send({ targets: [" 9000001234 "] });
    expect(res.status).toBe(200);
    expect(res.body.comment.body).toBe("Loan [redacted …1234] at Example Bank");
    expect(res.body.placesChanged).toEqual(counts);
    expect(mockRedact).toHaveBeenCalledWith(expect.anything(), {
      companyId: "company-1",
      commentId: "comment-1",
      targets: ["9000001234"],
      keepLast4: true,
      runLogBaseDir: "/tmp/test-run-logs",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.comment_redacted",
        details: expect.objectContaining({ commentId: "comment-1", textsHidden: 1, placesChanged: counts }),
      }),
    );
    expect(JSON.stringify((mockLogActivity.mock.calls as unknown[][])[0]?.[1])).not.toContain("9000001234");
  });

  it("refuses an agent, even one in the same company, and changes nothing", async () => {
    const app = await installActor(createApp(), {
      type: "agent",
      agentId: "22222222-2222-4222-8222-222222222222",
      companyId: "company-1",
      source: "agent_key",
    });
    const res = await request(app).post(URL).send({ targets: ["9000001234"] });
    expect(res.status).toBe(403);
    expect(mockRedact).not.toHaveBeenCalled();
  });

  it("refuses a board user of another company", async () => {
    const app = await installActor(createApp(), {
      type: "board",
      userId: "other-board",
      companyIds: ["company-2"],
      source: "session",
      isInstanceAdmin: false,
    });
    const res = await request(app).post(URL).send({ targets: ["9000001234"] });
    expect(res.status).toBe(403);
    expect(mockRedact).not.toHaveBeenCalled();
  });

  it("says so when the text is not in the comment, and refuses unsafe or too-short text", async () => {
    mockRedact.mockResolvedValueOnce({ comment: makeComment(), replaced: 0, counts, otherCommentsWithText: 0, notReachable: [] });
    const missing = await request(await installActor(createApp())).post(URL).send({ targets: ["1111222233"] });
    expect(missing.status).toBe(422);
    expect(mockLogActivity).not.toHaveBeenCalled();

    const short = await request(await installActor(createApp())).post(URL).send({ targets: ["123"] });
    expect(short.status).toBe(400);
    const quoted = await request(await installActor(createApp())).post(URL).send({ targets: ['90"01234'] });
    expect(quoted.status).toBe(400);
  });

  it("does not redact a comment from another issue", async () => {
    mockIssueService.getComment.mockResolvedValue(makeComment({ issueId: "33333333-3333-4333-8333-333333333333" }));
    const res = await request(await installActor(createApp())).post(URL).send({ targets: ["9000001234"] });
    expect(res.status).toBe(404);
    expect(mockRedact).not.toHaveBeenCalled();
  });
});
