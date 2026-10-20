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
const mockPreview = vi.hoisted(() => vi.fn());
const mockAuthorize = vi.hoisted(() => vi.fn());
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
    authorizeCommentRedaction: mockAuthorize,
    previewCommentRedaction: mockPreview,
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
const BODY = "Loan 9000001234 at Example Bank";
const selection = { targets: ["9000001234"], expectedBody: BODY };
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

  it.each(["redaction-preview", "redact", "redaction-authorizations"])("reports a body-size validation failure specifically on %s", async (action) => {
    const app = await installActor(createApp());
    // Supply parsed input to the mocked route fixture, bypassing its small body
    // reader. The actual createApp HTTP fixture verifies the real 30 MiB reader.
    const body = { ...selection, expectedBody: "\u00e9".repeat(16 * 1024 * 1024), agentId: "00000000-0000-4000-8000-000000000001" };
    if (action !== "redaction-authorizations") delete (body as any).agentId;
    const parsedApp = express();
    parsedApp.use((req, _res, next) => { req.body = body; next(); });
    parsedApp.use(app);
    const result = await request(parsedApp).post(URL.replace(/redact$/, action));
    expect(result.status).toBe(400);
    expect(result.body.error).toContain("30 MiB UTF-8 limit");
    expect(result.body.error).not.toContain("Select 4");
    expect(mockRedact).not.toHaveBeenCalled();
    expect(mockAuthorize).not.toHaveBeenCalled();
    expect(mockPreview).not.toHaveBeenCalled();
  });

  it("redacts for the board, keeping the last 4 by default, and logs no hidden text", async () => {
    const res = await request(await installActor(createApp())).post(URL).send(selection);
    expect(res.status).toBe(200);
    expect(res.body.comment.body).toBe("Loan [redacted …1234] at Example Bank");
    expect(res.body.placesChanged).toEqual(counts);
    expect(mockRedact).toHaveBeenCalledWith(expect.anything(), {
      companyId: "company-1",
      issueId: ISSUE,
      commentId: "comment-1",
      selection: { ...selection, keepLast4: true },
      actor: expect.objectContaining({ actorType: "user", actorId: "local-board" }),
      runLogBaseDir: "/tmp/test-run-logs",
    });
    // The real service persists the audit in the same transaction as the redaction.
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("derives preview ownership from the board actor and refuses a supplied owner", async () => {
    mockPreview.mockResolvedValue({ counts, impactToken: "a".repeat(64), estimated: true, residualMatches: 0, oversizedFields: 0 });
    const app = await installActor(createApp());
    const url = URL.replace(/redact$/, "redaction-preview");
    expect((await request(app).post(url).send(selection)).status).toBe(200);
    expect(mockPreview).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ requestedByUserId: "local-board" }));
    expect((await request(app).post(url).send({ ...selection, requestedByUserId: "other-board" })).status).toBe(400);
  });

  it("rejects unpaired Unicode surrogates with 400 before every selection service", async () => {
    const app = await installActor(createApp());
    for (const action of ["redact", "redaction-preview", "redaction-authorizations"]) {
      const res = await request(app).post(URL.replace(/redact$/, action)).send({ ...selection, targets: ["abc\ud800"],
        ...(action === "redaction-authorizations" ? { agentId: "22222222-2222-4222-8222-222222222222" } : {}) });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain("abc");
    }
    expect(mockRedact).not.toHaveBeenCalled();
    expect(mockPreview).not.toHaveBeenCalled();
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it("refuses an agent, even one in the same company, and changes nothing", async () => {
    const app = await installActor(createApp(), {
      type: "agent",
      agentId: "22222222-2222-4222-8222-222222222222",
      companyId: "company-1",
      source: "agent_key",
    });
    const res = await request(app).post(URL).send(selection);
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
    const res = await request(app).post(URL).send(selection);
    expect(res.status).toBe(403);
    expect(mockRedact).not.toHaveBeenCalled();
  });

  it("returns fixed errors for absent text and malformed selections without echoing any values", async () => {
    const { unprocessable } = await import("../errors.js");
    mockRedact.mockRejectedValueOnce(unprocessable("Every selected text must appear exactly in this comment."));
    const missing = await request(await installActor(createApp())).post(URL).send({ ...selection, targets: ["1111222233"] });
    expect(missing.status).toBe(422);
    expect(mockLogActivity).not.toHaveBeenCalled();

    const short = await request(await installActor(createApp())).post(URL).send({ targets: ["example-private-value"] });
    expect(short.status).toBe(400);
    expect(JSON.stringify(short.body)).not.toContain("example-private-value");
    const extra = await request(await installActor(createApp())).post(URL).send({ ...selection, force: true });
    expect(extra.status).toBe(400);
  });

  it("does not redact a comment from another issue", async () => {
    const { notFound } = await import("../errors.js");
    mockRedact.mockRejectedValueOnce(notFound("Comment not found"));
    const res = await request(await installActor(createApp())).post(URL).send(selection);
    expect(res.status).toBe(404);
    expect(mockRedact).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ issueId: ISSUE, companyId: "company-1" }));
  });

  it("creates an issue-scoped instruction only for a board actor", async () => {
    const agentId = "22222222-2222-4222-8222-222222222222";
    mockAuthorize.mockResolvedValue({ authorizationId: ISSUE });
    const url = URL.replace(/redact$/, "redaction-authorizations");
    const result = await request(await installActor(createApp())).post(url).send({ ...selection, agentId });
    expect(result.status).toBe(201);
    expect(mockAuthorize).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      requestedByUserId: "local-board", requestedByLocalBoard: true, companyId: "company-1", issueId: ISSUE, agentId,
    }));
    const agent = await installActor(createApp(), { type: "agent", companyId: "company-1", agentId });
    expect((await request(agent).post(url).send({ ...selection, agentId })).status).toBe(403);
  });

  it("requires an agent and an unaltered authorization on the delegated path", async () => {
    const url = `${URL}-delegated`;
    const board = await installActor(createApp());
    expect((await request(board).post(url).send({ authorizationId: ISSUE })).status).toBe(403);
    const agentId = "22222222-2222-4222-8222-222222222222";
    const agent = await installActor(createApp(), { type: "agent", companyId: "company-1", agentId });
    expect((await request(agent).post(url).send({ authorizationId: ISSUE, ...selection })).status).toBe(400);
    const ok = await request(agent).post(url).send({ authorizationId: ISSUE });
    expect(ok.status).toBe(200);
    expect(mockRedact).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      authorizationId: ISSUE, actor: expect.objectContaining({ actorType: "agent", agentId }),
    }));
    const otherCompany = await installActor(createApp(), { type: "agent", companyId: "company-2", agentId, isPortfolioRootAgent: true });
    expect((await request(otherCompany).post(url).send({ authorizationId: ISSUE })).status).toBe(403);
  });

  it("refuses viewers, tool sessions, unauthenticated callers, and raw driver errors cannot leak text", async () => {
    for (const actor of [
      { type: "none" },
      { type: "tool_session", companyId: "company-1", userId: "local-board" },
      { type: "board", companyIds: ["company-1"], source: "session", memberships: [{ companyId: "company-1", status: "active", membershipRole: "viewer" }] },
    ]) {
      expect((await request(await installActor(createApp(), actor)).post(URL).send(selection)).status).toBe(403);
    }
    mockRedact.mockRejectedValueOnce(new Error("driver query example-private-value"));
    const error = await request(await installActor(createApp())).post(URL).send(selection);
    expect(error.status).toBe(500);
    expect(JSON.stringify(error.body)).not.toContain("example-private-value");
  });
});
