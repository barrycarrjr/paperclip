import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockConnectorService = vi.hoisted(() => ({
  listForSurface: vi.fn(),
}));

vi.mock("../services/plugin-connectors.js", () => ({
  pluginConnectorService: () => mockConnectorService,
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => ({ getById: vi.fn(), getByKey: vi.fn(), upsertConfig: vi.fn() }),
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => ({ load: vi.fn(), upgrade: vi.fn(), unload: vi.fn() }),
}));

vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));
vi.mock("../services/live-events.js", () => ({ publishGlobalLiveEvent: vi.fn() }));

async function createApp(actor: Record<string, unknown>) {
  const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"),
    import("../middleware/index.js"),
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use("/api", pluginRoutes({} as never, { installPlugin: vi.fn() } as never));
  app.use(errorHandler);
  return app;
}

const BOARD_ACTOR = { type: "board", userId: "user-1", companyIds: ["company-a"], source: "session" };

describe("GET /api/plugins/connectors", () => {
  beforeEach(() => {
    mockConnectorService.listForSurface.mockReset();
  });

  it("returns the connector statuses for the requested surface", async () => {
    const payload = [
      {
        pluginId: "plugin-1",
        pluginKey: "paperclip.google-workspace",
        pluginDisplayName: "Google Workspace",
        connectorId: "google-calendar",
        displayName: "Google Calendar",
        surface: "calendar",
        pluginEnabled: true,
        unfinishedAccounts: [],
        companies: [
          {
            companyId: "company-a",
            companyName: "Industry Bureau LLC",
            connected: true,
            accountLabel: "books@ib.com",
            viaPortfolioWide: false,
          },
        ],
      },
    ];
    mockConnectorService.listForSurface.mockResolvedValue(payload);

    const res = await request(await createApp(BOARD_ACTOR)).get("/api/plugins/connectors?surface=calendar");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
    expect(mockConnectorService.listForSurface).toHaveBeenCalledWith("calendar");
  });

  it("returns an empty list when nothing declares a connector", async () => {
    mockConnectorService.listForSurface.mockResolvedValue([]);

    const res = await request(await createApp(BOARD_ACTOR)).get("/api/plugins/connectors?surface=calendar");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("rejects a surface the board does not have", async () => {
    const res = await request(await createApp(BOARD_ACTOR)).get("/api/plugins/connectors?surface=payroll");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Unknown connector surface");
    expect(mockConnectorService.listForSurface).not.toHaveBeenCalled();
  });

  it("rejects a request with no surface at all", async () => {
    const res = await request(await createApp(BOARD_ACTOR)).get("/api/plugins/connectors");

    expect(res.status).toBe(400);
  });

  // The route sits before /plugins/:pluginId, so Express must not read
  // "connectors" as a plugin id.
  it("is not swallowed by the parameterized plugin route", async () => {
    mockConnectorService.listForSurface.mockResolvedValue([]);

    const res = await request(await createApp(BOARD_ACTOR)).get("/api/plugins/connectors?surface=calendar");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("refuses an agent actor the way every other board plugin route does", async () => {
    const res = await request(
      await createApp({ type: "agent", agentId: "agent-1", companyId: "company-a", source: "token" }),
    ).get("/api/plugins/connectors?surface=calendar");

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockConnectorService.listForSurface).not.toHaveBeenCalled();
  });
});
