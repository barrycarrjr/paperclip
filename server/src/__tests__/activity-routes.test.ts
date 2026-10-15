import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockActivityService = vi.hoisted(() => ({
  list: vi.fn(),
  forIssue: vi.fn(),
  runsForIssue: vi.fn(),
  issuesForRun: vi.fn(),
  create: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
}));

vi.mock("../services/activity.js", () => ({
  activityService: () => mockActivityService,
  normalizeActivityLimit: (limit: number | undefined) => {
    if (!Number.isFinite(limit)) return 100;
    return Math.max(1, Math.min(500, Math.floor(limit ?? 100)));
  },
}));

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
  heartbeatService: () => mockHeartbeatService,
}));

const INSTANCE_ADMIN = {
  type: "board",
  userId: "admin-1",
  companyIds: ["company-1"],
  source: "session",
  isInstanceAdmin: true,
};

async function createApp(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "user-1",
    companyIds: ["company-1"],
    source: "session",
    isInstanceAdmin: false,
  },
) {
  vi.resetModules();
  const [{ errorHandler }, { activityRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/activity.js") as Promise<typeof import("../routes/activity.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      ...actor,
      companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
    };
    next();
  });
  app.use("/api", activityRoutes({} as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

describe.sequential("activity routes", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockActivityService)) mock.mockReset();
    for (const mock of Object.values(mockHeartbeatService)) mock.mockReset();
    for (const mock of Object.values(mockIssueService)) mock.mockReset();
  });

  it("limits company activity lists by default", async () => {
    mockActivityService.list.mockResolvedValue([]);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get("/api/companies/company-1/activity"));

    expect(res.status).toBe(200);
    expect(mockActivityService.list).toHaveBeenCalledWith({
      companyId: "company-1",
      agentId: undefined,
      entityType: undefined,
      entityId: undefined,
      limit: 100,
    });
  });

  it("caps requested company activity list limits", async () => {
    mockActivityService.list.mockResolvedValue([]);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/companies/company-1/activity?limit=5000&entityType=issue"),
    );

    expect(res.status).toBe(200);
    expect(mockActivityService.list).toHaveBeenCalledWith({
      companyId: "company-1",
      agentId: undefined,
      entityType: "issue",
      entityId: undefined,
      limit: 500,
    });
  });

  it("resolves issue identifiers before loading runs", async () => {
    mockIssueService.getByIdentifier.mockResolvedValue({
      id: "issue-uuid-1",
      companyId: "company-1",
    });
    mockActivityService.runsForIssue.mockResolvedValue([
      {
        runId: "run-1",
        adapterType: "codex_local",
        resultJson: { runCounts: { itemsRead: 0, entriesAdded: 0, changesProposed: 0 } },
      },
    ]);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get("/api/issues/PAP-475/runs"));

    expect(res.status).toBe(200);
    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith("PAP-475");
    expect(mockIssueService.getById).not.toHaveBeenCalled();
    expect(mockActivityService.runsForIssue).toHaveBeenCalledWith("company-1", "issue-uuid-1");
    expect(res.body).toEqual([{ runId: "run-1", adapterType: "codex_local", resultJson: { runCounts: { itemsRead: 0, entriesAdded: 0, changesProposed: 0 } } }]);
  });

  it("requires company access before creating activity events", async () => {
    const app = await createApp(INSTANCE_ADMIN);
    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post("/api/companies/company-2/activity")
      .send({
        actorId: "user-1",
        action: "test.event",
        entityType: "issue",
        entityId: "issue-1",
      }));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("User does not have access to this company");
    expect(mockActivityService.create).not.toHaveBeenCalled();
  });

  it("refuses a member who is not an instance admin creating activity events", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/activity")
      .send({ action: "issue.start_work.planned", entityType: "issue", entityId: "issue-1" }));

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Instance admin access required");
    expect(mockActivityService.create).not.toHaveBeenCalled();
  });

  it("records the caller, not an actor named in the body, when creating activity events", async () => {
    mockActivityService.create.mockImplementation(async (row: Record<string, unknown>) => ({ id: "event-1", ...row }));

    const app = await createApp(INSTANCE_ADMIN);
    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/activity")
      .send({
        actorType: "agent",
        actorId: "33333333-3333-4333-8333-333333333333",
        agentId: "33333333-3333-4333-8333-333333333333",
        action: "secret.deleted",
        entityType: "secret",
        entityId: "secret-1",
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockActivityService.create).toHaveBeenCalledTimes(1);
    const row = mockActivityService.create.mock.calls[0]![0];
    expect(row).toMatchObject({
      companyId: "company-1",
      actorType: "user",
      actorId: "admin-1",
      agentId: null,
      action: "secret.deleted",
      entityType: "secret",
      entityId: "secret-1",
    });
    expect(res.body).toMatchObject({ actorType: "user", actorId: "admin-1", agentId: null });
  });

  it("accepts an activity event that names no actor and records the caller", async () => {
    mockActivityService.create.mockImplementation(async (row: Record<string, unknown>) => ({ id: "event-2", ...row }));

    const app = await createApp(INSTANCE_ADMIN);
    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/activity")
      .send({ action: "note.added", entityType: "issue", entityId: "issue-1" }));

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockActivityService.create).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "company-1",
      actorType: "user",
      actorId: "admin-1",
      agentId: null,
    }));
  });

  it("reads an issue's timeline from the issue's own company only", async () => {
    const issueId = "44444444-4444-4444-8444-444444444444";
    mockIssueService.getById.mockResolvedValue({ id: issueId, companyId: "company-1" });
    mockActivityService.forIssue.mockResolvedValue([]);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/issues/${issueId}/activity`));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockActivityService.forIssue).toHaveBeenCalledWith(issueId, "company-1");
  });

  it("lets a portfolio-root agent read another company's issue activity and run ledger", async () => {
    const issueId = "55555555-5555-4555-8555-555555555555";
    mockIssueService.getById.mockResolvedValue({ id: issueId, companyId: "company-2" });
    mockActivityService.forIssue.mockResolvedValue([]);
    mockActivityService.runsForIssue.mockResolvedValue([]);

    const app = await createApp({
      type: "agent",
      agentId: "agent-hq",
      companyId: "company-hq",
      isPortfolioRootAgent: true,
      source: "agent_key",
    });
    const activity = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/issues/${issueId}/activity`));
    const runs = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/issues/${issueId}/runs`));

    expect(activity.status, JSON.stringify(activity.body)).toBe(200);
    expect(runs.status, JSON.stringify(runs.body)).toBe(200);
    expect(mockActivityService.forIssue).toHaveBeenCalledWith(issueId, "company-2");
    expect(mockActivityService.runsForIssue).toHaveBeenCalledWith("company-2", issueId);
  });

  it("keeps an ordinary agent out of another company's issue activity and run ledger", async () => {
    const issueId = "66666666-6666-4666-8666-666666666666";
    mockIssueService.getById.mockResolvedValue({ id: issueId, companyId: "company-2" });

    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
    });
    const activity = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/issues/${issueId}/activity`));
    const runs = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/issues/${issueId}/runs`));

    expect(activity.status).toBe(403);
    expect(runs.status).toBe(403);
    expect(mockActivityService.forIssue).not.toHaveBeenCalled();
    expect(mockActivityService.runsForIssue).not.toHaveBeenCalled();
  });

  it("keeps a portfolio-root tool session bound to its own company for issue activity and run ledgers", async () => {
    const issueId = "77777777-7777-4777-8777-777777777777";
    mockIssueService.getById.mockResolvedValue({ id: issueId, companyId: "company-2" });

    const app = await createApp({
      type: "tool_session",
      userId: "hq-owner",
      companyId: "company-hq",
      toolSessionId: "clippy-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      isPortfolioRootAgent: true,
      source: "tool_session_jwt",
    });
    const activity = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/issues/${issueId}/activity`));
    const runs = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/issues/${issueId}/runs`));

    expect(activity.status).toBe(403);
    expect(runs.status).toBe(403);
    expect(mockActivityService.forIssue).not.toHaveBeenCalled();
    expect(mockActivityService.runsForIssue).not.toHaveBeenCalled();
  });

  it("keeps a Personal company's issue activity and run ledger private from portfolio-root agents", async () => {
    const issueId = "88888888-8888-4888-8888-888888888888";
    const personalCompanyId = "99999999-9999-4999-8999-999999999999";
    mockIssueService.getById.mockResolvedValue({ id: issueId, companyId: personalCompanyId });

    const app = await createApp({
      type: "agent",
      agentId: "agent-hq",
      companyId: "company-hq",
      isPortfolioRootAgent: true,
      source: "agent_key",
    });
    const { rememberPersonalCompany } = await import("../services/personal-companies.js");
    rememberPersonalCompany(personalCompanyId, "personal-owner");

    const activity = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/issues/${issueId}/activity`));
    const runs = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/issues/${issueId}/runs`));

    expect(activity.status).toBe(403);
    expect(runs.status).toBe(403);
    expect(mockActivityService.forIssue).not.toHaveBeenCalled();
    expect(mockActivityService.runsForIssue).not.toHaveBeenCalled();
  });

  it("requires company access before listing issues for another company's run", async () => {
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-2",
      companyId: "company-2",
    });

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-2/issues"));

    expect(res.status).toBe(403);
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
  });

  it("rejects anonymous heartbeat run issue lookups before run existence checks", async () => {
    const app = await createApp({ type: "none", source: "none" });
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/missing-run/issues"));

    expect(res.status).toBe(401);
    expect(mockHeartbeatService.getRun).not.toHaveBeenCalled();
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
  });
});
