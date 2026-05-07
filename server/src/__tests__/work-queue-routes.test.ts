import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockWorkQueueService = vi.hoisted(() => ({
  listQueues: vi.fn(),
  getQueueById: vi.fn(),
  createQueue: vi.fn(),
  updateQueue: vi.fn(),
  deleteQueue: vi.fn(),
  listItems: vi.fn(),
  getItemById: vi.fn(),
  enqueue: vi.fn(),
  claim: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  cancel: vi.fn(),
}));

class MockWorkQueueClaimRaceError extends Error {
  constructor() {
    super("Work queue item is no longer pending");
    this.name = "WorkQueueClaimRaceError";
  }
}

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../services/index.js", () => ({
  workQueueService: () => mockWorkQueueService,
  WorkQueueClaimRaceError: MockWorkQueueClaimRaceError,
  logActivity: mockLogActivity,
}));

async function createApp(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "user-1",
    companyIds: ["company-1"],
    source: "session",
    isInstanceAdmin: false,
    memberships: [{ companyId: "company-1", status: "active", membershipRole: "operator" }],
  },
) {
  vi.resetModules();
  const [{ errorHandler }, { workQueueRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/work-queues.js") as Promise<typeof import("../routes/work-queues.js")>,
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
  app.use("/api", workQueueRoutes({} as any));
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

describe.sequential("work queue routes", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockWorkQueueService)) mock.mockReset();
    mockLogActivity.mockReset();
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("creates a queue with a slug and rejects bad slugs at the validator", async () => {
    mockWorkQueueService.createQueue.mockResolvedValue({
      id: "q-1",
      slug: "support",
      name: "Support",
      companyId: "company-1",
    });
    const app = await createApp();
    const ok = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/work-queues")
        .send({ slug: "support", name: "Support" }),
    );
    expect(ok.status).toBe(201);
    expect(mockWorkQueueService.createQueue).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ slug: "support", name: "Support" }),
    );

    const bad = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/work-queues")
        .send({ slug: "Bad Slug!", name: "x" }),
    );
    expect(bad.status).toBe(400);
  });

  it("blocks creating a queue in a company the actor cannot access", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-2/work-queues")
        .send({ slug: "x", name: "x" }),
    );
    expect(res.status).toBe(403);
    expect(mockWorkQueueService.createQueue).not.toHaveBeenCalled();
  });

  it("enqueues an item only when the queue is active", async () => {
    mockWorkQueueService.getQueueById.mockResolvedValueOnce({
      id: "q-1",
      companyId: "company-1",
      isActive: false,
    });
    const app = await createApp();
    const inactive = await requestApp(app, (baseUrl) =>
      request(baseUrl).post("/api/work-queues/q-1/items").send({ payload: { foo: "bar" } }),
    );
    expect(inactive.status).toBe(422);

    mockWorkQueueService.getQueueById.mockResolvedValueOnce({
      id: "q-1",
      companyId: "company-1",
      isActive: true,
    });
    mockWorkQueueService.enqueue.mockResolvedValue({
      id: "i-1",
      queueId: "q-1",
      companyId: "company-1",
      externalSource: null,
      externalId: null,
    });
    const ok = await requestApp(app, (baseUrl) =>
      request(baseUrl).post("/api/work-queues/q-1/items").send({ payload: { foo: "bar" } }),
    );
    expect(ok.status).toBe(201);
    expect(mockWorkQueueService.enqueue).toHaveBeenCalledWith("q-1", "company-1", {
      payload: { foo: "bar" },
    });
  });

  it("only agents can claim items, and a race throws 409", async () => {
    mockWorkQueueService.getItemById.mockResolvedValue({
      id: "i-1",
      companyId: "company-1",
    });
    const userApp = await createApp();
    const userRes = await requestApp(userApp, (baseUrl) =>
      request(baseUrl).post("/api/work-queue-items/i-1/claim"),
    );
    expect(userRes.status).toBe(403);
    expect(mockWorkQueueService.claim).not.toHaveBeenCalled();

    const agentApp = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
    });
    mockWorkQueueService.claim.mockRejectedValueOnce(new MockWorkQueueClaimRaceError());
    const raceRes = await requestApp(agentApp, (baseUrl) =>
      request(baseUrl).post("/api/work-queue-items/i-1/claim"),
    );
    expect(raceRes.status).toBe(409);

    mockWorkQueueService.claim.mockResolvedValueOnce({
      id: "i-1",
      companyId: "company-1",
      status: "claimed",
      claimedByAgentId: "agent-1",
    });
    const okRes = await requestApp(agentApp, (baseUrl) =>
      request(baseUrl).post("/api/work-queue-items/i-1/claim"),
    );
    expect(okRes.status).toBe(200);
    expect(mockWorkQueueService.claim).toHaveBeenLastCalledWith("i-1", "agent-1");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "work_queue.item.claimed" }),
    );
  });

  it("forbids completing an item claimed by a different agent", async () => {
    mockWorkQueueService.getItemById.mockResolvedValue({
      id: "i-1",
      companyId: "company-1",
      claimedByAgentId: "agent-other",
    });
    const app = await createApp({
      type: "agent",
      agentId: "agent-self",
      companyId: "company-1",
      source: "agent_key",
    });
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post("/api/work-queue-items/i-1/complete").send({}),
    );
    expect(res.status).toBe(403);
    expect(mockWorkQueueService.complete).not.toHaveBeenCalled();
  });

  it("completes an item the same agent claimed", async () => {
    mockWorkQueueService.getItemById.mockResolvedValue({
      id: "i-1",
      companyId: "company-1",
      claimedByAgentId: "agent-self",
    });
    mockWorkQueueService.complete.mockResolvedValue({
      id: "i-1",
      companyId: "company-1",
      status: "completed",
    });
    const app = await createApp({
      type: "agent",
      agentId: "agent-self",
      companyId: "company-1",
      source: "agent_key",
    });
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/work-queue-items/i-1/complete")
        .send({ issueId: "00000000-0000-0000-0000-000000000001" }),
    );
    expect(res.status).toBe(200);
    expect(mockWorkQueueService.complete).toHaveBeenCalledWith("i-1", {
      issueId: "00000000-0000-0000-0000-000000000001",
    });
  });

  it("requires a reason to fail an item", async () => {
    mockWorkQueueService.getItemById.mockResolvedValue({
      id: "i-1",
      companyId: "company-1",
      claimedByAgentId: null,
    });
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post("/api/work-queue-items/i-1/fail").send({}),
    );
    expect(res.status).toBe(400);
    expect(mockWorkQueueService.fail).not.toHaveBeenCalled();
  });

  it("lists items filtered by status", async () => {
    mockWorkQueueService.getQueueById.mockResolvedValue({
      id: "q-1",
      companyId: "company-1",
    });
    mockWorkQueueService.listItems.mockResolvedValue([{ id: "i-1", status: "pending" }]);
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/work-queues/q-1/items?status=pending&limit=10"),
    );
    expect(res.status).toBe(200);
    expect(mockWorkQueueService.listItems).toHaveBeenCalledWith("q-1", {
      status: "pending",
      limit: 10,
    });
  });
});
