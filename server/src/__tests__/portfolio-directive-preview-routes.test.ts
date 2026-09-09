import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two HTTP ends of the preview step: asking what a broadcast would do,
 * and sending the one that was asked about. The service is on trial
 * elsewhere; here it is the wiring, the access checks and the body handling.
 */

const HQ_ID = "11111111-1111-4111-8111-111111111111";
const PREVIEW_ID = "a".repeat(64);

const mockPreview = vi.hoisted(() => vi.fn());
const mockBroadcast = vi.hoisted(() => vi.fn());
const mockGetCompanyById = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/portfolio-directive.js", () => ({
    portfolioDirectiveService: () => ({ preview: mockPreview, broadcast: mockBroadcast }),
    PORTFOLIO_DIRECTIVE_ORIGIN_KIND: "portfolio_directive",
  }));
  vi.doMock("../services/index.js", () => ({
    accessService: () => ({ canUser: async () => true, hasPermission: async () => true }),
    agentService: () => ({}),
    companyService: () => ({ getById: mockGetCompanyById }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    goalService: () => ({}),
    heartbeatService: () => ({}),
    instanceSettingsService: () => ({}),
    issueApprovalService: () => ({}),
    issueReferenceService: () => ({}),
    issueService: () => ({}),
    logActivity: async () => undefined,
    projectService: () => ({}),
    routineService: () => ({}),
    workProductService: () => ({}),
  }));
}

async function createApp(actorOverrides: Record<string, unknown> = {}) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: [HQ_ID],
      source: "local_implicit",
      isInstanceAdmin: false,
      ...actorOverrides,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

const PREVIEW_PATH = `/api/companies/${HQ_ID}/portfolio-directives/preview`;
const SEND_PATH = `/api/companies/${HQ_ID}/portfolio-directives`;

describe("portfolio directive preview routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/portfolio-directive.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockGetCompanyById.mockResolvedValue({ id: HQ_ID, name: "HQ", isPortfolioRoot: true });
    mockPreview.mockResolvedValue({
      previewId: PREVIEW_ID,
      intent: "Reply to every Google review",
      title: "Directive: Reply to every Google review",
      willReceive: [{ companyId: "c1", companyName: "Acme", lead: { id: "ceo-1", name: "Ada" } }],
      skipped: [],
      guardrails: { outboundHold: true },
      summaryLines: ["Goes to 1 company, named below with the lead who receives it."],
    });
    mockBroadcast.mockResolvedValue({
      directiveId: "d-1",
      intent: "Reply to every Google review",
      title: "Directive: Reply to every Google review",
      dispatched: [],
      skipped: [],
    });
  });

  it("answers the preview without sending anything", async () => {
    const app = await createApp();
    const res = await request(app).post(PREVIEW_PATH).send({ intent: "Reply to every Google review" });

    expect(res.status).toBe(200);
    expect(res.body.previewId).toBe(PREVIEW_ID);
    expect(res.body.willReceive).toHaveLength(1);
    expect(mockPreview).toHaveBeenCalledTimes(1);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("refuses a send with no previewId before the service is ever reached", async () => {
    const app = await createApp();
    const res = await request(app).post(SEND_PATH).send({ intent: "Reply to every Google review" });

    expect(res.status).toBe(400);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("passes the previewId through to the service on a send", async () => {
    const app = await createApp();
    const res = await request(app)
      .post(SEND_PATH)
      .send({ intent: "Reply to every Google review", previewId: PREVIEW_ID });

    expect(res.status).toBe(201);
    expect(mockBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "Reply to every Google review", previewId: PREVIEW_ID }),
    );
  });

  it("only answers a preview at HQ", async () => {
    mockGetCompanyById.mockResolvedValue({ id: HQ_ID, name: "Acme", isPortfolioRoot: false });
    const app = await createApp();
    const res = await request(app).post(PREVIEW_PATH).send({ intent: "Reply to every Google review" });

    expect(res.status).toBe(403);
    expect(mockPreview).not.toHaveBeenCalled();
  });

  it("refuses a preview for an ordinary member who is not a portfolio root admin", async () => {
    const app = await createApp({ source: "session" });
    const res = await request(app).post(PREVIEW_PATH).send({ intent: "Reply to every Google review" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Portfolio root access required");
    expect(mockPreview).not.toHaveBeenCalled();
  });
});
