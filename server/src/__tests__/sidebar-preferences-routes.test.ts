import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSidebarPreferenceService = vi.hoisted(() => ({
  getCompanyOrder: vi.fn(),
  upsertCompanyOrder: vi.fn(),
  getProjectOrder: vi.fn(),
  upsertProjectOrder: vi.fn(),
  getPinnedWorkspaces: vi.fn(),
  upsertPinnedWorkspaces: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    sidebarPreferenceService: () => mockSidebarPreferenceService,
    logActivity: mockLogActivity,
  }));
}

async function createApp(actor: Record<string, unknown>) {
  const [{ sidebarPreferenceRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/sidebar-preferences.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as never;
    next();
  });
  app.use("/api", sidebarPreferenceRoutes({} as never));
  app.use(errorHandler);
  return app;
}

const ORDERED_IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];

describe("sidebar preference routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/sidebar-preferences.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockSidebarPreferenceService.getCompanyOrder.mockResolvedValue({
      orderedIds: ORDERED_IDS,
      updatedAt: null,
    });
    mockSidebarPreferenceService.upsertCompanyOrder.mockResolvedValue({
      orderedIds: ORDERED_IDS,
      updatedAt: null,
    });
    mockSidebarPreferenceService.getProjectOrder.mockResolvedValue({
      orderedIds: ORDERED_IDS,
      updatedAt: null,
    });
    mockSidebarPreferenceService.upsertProjectOrder.mockResolvedValue({
      orderedIds: ORDERED_IDS,
      updatedAt: null,
    });
  });

  it("returns company rail order for board users", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app).get("/api/sidebar-preferences/me");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      orderedIds: ORDERED_IDS,
      updatedAt: null,
    });
    expect(mockSidebarPreferenceService.getCompanyOrder).toHaveBeenCalledWith("user-1");
  });

  it("updates company rail order for board users", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: ["company-1"],
    });

    const res = await request(app)
      .put("/api/sidebar-preferences/me")
      .send({ orderedIds: ORDERED_IDS });

    expect(res.status).toBe(200);
    expect(mockSidebarPreferenceService.upsertCompanyOrder).toHaveBeenCalledWith("user-1", ORDERED_IDS);
  });

  it("returns project order for companies the board user can access", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app).get("/api/companies/company-1/sidebar-preferences/me");

    expect(res.status).toBe(200);
    expect(mockSidebarPreferenceService.getProjectOrder).toHaveBeenCalledWith("company-1", "user-1");
  });

  it("logs project order updates for company-scoped writes", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      runId: "run-1",
    });

    const res = await request(app)
      .put("/api/companies/company-1/sidebar-preferences/me")
      .send({ orderedIds: ORDERED_IDS });

    expect(res.status).toBe(200);
    expect(mockSidebarPreferenceService.upsertProjectOrder).toHaveBeenCalledWith("company-1", "user-1", ORDERED_IDS);
    expect(mockLogActivity).toHaveBeenCalledWith(
      {} as never,
      expect.objectContaining({
        companyId: "company-1",
        action: "sidebar_preferences.project_order_updated",
        details: expect.objectContaining({
          userId: "user-1",
          orderedIds: ORDERED_IDS,
        }),
      }),
    );
  });

  it("rejects company-scoped reads when the board user lacks company access", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-2"],
    });

    const res = await request(app).get("/api/companies/company-1/sidebar-preferences/me");

    expect(res.status).toBe(403);
    expect(mockSidebarPreferenceService.getProjectOrder).not.toHaveBeenCalled();
  });

  it("rejects agent callers", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
    });

    const res = await request(app).get("/api/sidebar-preferences/me");

    expect(res.status).toBe(403);
    expect(mockSidebarPreferenceService.getCompanyOrder).not.toHaveBeenCalled();
  });

  describe("pinned workspaces", () => {
    const boardActor = {
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    };

    it("returns this person's pins", async () => {
      mockSidebarPreferenceService.getPinnedWorkspaces.mockResolvedValue({
        orderedIds: ["email", "notepad"],
        updatedAt: null,
      });
      const app = await createApp(boardActor);

      const res = await request(app).get("/api/sidebar-preferences/me/pinned-workspaces");

      expect(res.status).toBe(200);
      expect(res.body.orderedIds).toEqual(["email", "notepad"]);
      expect(mockSidebarPreferenceService.getPinnedWorkspaces).toHaveBeenCalledWith("user-1");
    });

    it("saves a new list of pins", async () => {
      mockSidebarPreferenceService.upsertPinnedWorkspaces.mockResolvedValue({
        orderedIds: ["email"],
        updatedAt: null,
      });
      const app = await createApp(boardActor);

      const res = await request(app)
        .put("/api/sidebar-preferences/me/pinned-workspaces")
        .send({ orderedIds: ["email"] });

      expect(res.status).toBe(200);
      expect(mockSidebarPreferenceService.upsertPinnedWorkspaces).toHaveBeenCalledWith("user-1", [
        "email",
      ]);
    });

    it("accepts core ids and plugin route paths, and refuses anything else", async () => {
      mockSidebarPreferenceService.upsertPinnedWorkspaces.mockResolvedValue({
        orderedIds: [],
        updatedAt: null,
      });
      const app = await createApp(boardActor);

      const ok = await request(app)
        .put("/api/sidebar-preferences/me/pinned-workspaces")
        .send({ orderedIds: ["email", "portfolio-brief", "notepad"] });
      expect(ok.status).toBe(200);

      // A path, not a slug — the column is not a place to store arbitrary
      // strings, and a stored path would render as a broken link.
      const bad = await request(app)
        .put("/api/sidebar-preferences/me/pinned-workspaces")
        .send({ orderedIds: ["../../etc/passwd"] });
      expect(bad.status).toBe(400);
    });

    it("refuses an unreasonably long list", async () => {
      const app = await createApp(boardActor);
      const res = await request(app)
        .put("/api/sidebar-preferences/me/pinned-workspaces")
        .send({ orderedIds: Array.from({ length: 31 }, (_, i) => `item-${i}`) });

      expect(res.status).toBe(400);
      expect(mockSidebarPreferenceService.upsertPinnedWorkspaces).not.toHaveBeenCalled();
    });

    it("rejects agent callers", async () => {
      const app = await createApp({
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        source: "agent_key",
      });

      const res = await request(app).get("/api/sidebar-preferences/me/pinned-workspaces");

      expect(res.status).toBe(403);
      expect(mockSidebarPreferenceService.getPinnedWorkspaces).not.toHaveBeenCalled();
    });
  });
});
