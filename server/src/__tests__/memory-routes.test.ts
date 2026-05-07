import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockMemoryService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  upsertByName: vi.fn(),
  remove: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../services/index.js", () => ({
  memoryService: () => mockMemoryService,
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
  const [{ errorHandler }, { memoryRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/memories.js") as Promise<typeof import("../routes/memories.js")>,
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
  app.use("/api", memoryRoutes({} as any));
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

describe.sequential("memory routes", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockMemoryService)) mock.mockReset();
    mockLogActivity.mockReset();
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("lists memories scoped to a company", async () => {
    mockMemoryService.list.mockResolvedValue([{ id: "m-1", name: "user_role" }]);
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/companies/company-1/memories"),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: "m-1", name: "user_role" }]);
    expect(mockMemoryService.list).toHaveBeenCalledWith("company-1", {});
  });

  it("forwards kind, agentId, q and limit filters", async () => {
    mockMemoryService.list.mockResolvedValue([]);
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(
        "/api/companies/company-1/memories?kind=feedback&agentId=11111111-1111-1111-1111-111111111111&q=foo&limit=25",
      ),
    );
    expect(res.status).toBe(200);
    expect(mockMemoryService.list).toHaveBeenCalledWith("company-1", {
      kind: "feedback",
      agentId: "11111111-1111-1111-1111-111111111111",
      q: "foo",
      limit: 25,
    });
  });

  it("rejects unknown memory kinds at the validator boundary", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/memories")
        .send({ kind: "diary", name: "n", content: "c" }),
    );
    expect(res.status).toBe(400);
    expect(mockMemoryService.create).not.toHaveBeenCalled();
  });

  it("creates memories and writes an activity entry", async () => {
    mockMemoryService.create.mockResolvedValue({
      id: "m-1",
      companyId: "company-1",
      kind: "user",
      name: "user_role",
    });
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/memories")
        .send({ kind: "user", name: "user_role", content: "Barry runs LLCs" }),
    );
    expect(res.status).toBe(201);
    expect(mockMemoryService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ kind: "user", name: "user_role" }),
      expect.objectContaining({ userId: "user-1" }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "memory.created",
        entityType: "memory",
        entityId: "m-1",
      }),
    );
  });

  it("blocks cross-company creates with 403", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-2/memories")
        .send({ kind: "user", name: "x", content: "y" }),
    );
    expect(res.status).toBe(403);
    expect(mockMemoryService.create).not.toHaveBeenCalled();
  });

  it("blocks reading a memory belonging to a company the actor cannot access", async () => {
    mockMemoryService.getById.mockResolvedValue({ id: "m-9", companyId: "company-2" });
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get("/api/memories/m-9"));
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown memory id", async () => {
    mockMemoryService.getById.mockResolvedValue(null);
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get("/api/memories/nope"));
    expect(res.status).toBe(404);
  });

  it("updates memories and logs activity", async () => {
    mockMemoryService.getById.mockResolvedValue({ id: "m-1", companyId: "company-1" });
    mockMemoryService.update.mockResolvedValue({
      id: "m-1",
      companyId: "company-1",
      content: "updated",
    });
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).patch("/api/memories/m-1").send({ content: "updated" }),
    );
    expect(res.status).toBe(200);
    expect(mockMemoryService.update).toHaveBeenCalledWith("m-1", { content: "updated" });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "memory.updated" }),
    );
  });

  it("deletes memories and logs activity", async () => {
    mockMemoryService.getById.mockResolvedValue({ id: "m-1", companyId: "company-1" });
    mockMemoryService.remove.mockResolvedValue({ id: "m-1", companyId: "company-1" });
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl).delete("/api/memories/m-1"));
    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "memory.deleted" }),
    );
  });
});
