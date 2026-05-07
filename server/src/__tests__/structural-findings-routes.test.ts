import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSvc = vi.hoisted(() => ({
  scan: vi.fn(),
}));

vi.mock("../services/structural-findings.js", async () => {
  const actual = await vi.importActual<typeof import("../services/structural-findings.js")>(
    "../services/structural-findings.js",
  );
  return {
    ...actual,
    structuralFindingService: () => mockSvc,
  };
});

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
  const [{ errorHandler }, { structuralFindingRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/structural-findings.js") as Promise<
      typeof import("../routes/structural-findings.js")
    >,
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
  app.use("/api", structuralFindingRoutes({} as any));
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

describe.sequential("structural findings routes", () => {
  beforeEach(() => {
    mockSvc.scan.mockReset();
  });

  it("returns findings wrapped in a {findings:[]} envelope", async () => {
    mockSvc.scan.mockResolvedValue([
      { kind: "idle_agent", fingerprint: "abc", subjectId: "agent-1" },
    ]);
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/companies/company-1/structural-findings"),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      findings: [{ kind: "idle_agent", fingerprint: "abc", subjectId: "agent-1" }],
    });
    expect(mockSvc.scan).toHaveBeenCalledWith("company-1", undefined);
  });

  it("forwards a comma-separated list of detector kinds, dropping unknown kinds", async () => {
    mockSvc.scan.mockResolvedValue([]);
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(
        "/api/companies/company-1/structural-findings?kinds=idle_agent,company_no_routines,bogus_kind",
      ),
    );
    expect(res.status).toBe(200);
    expect(mockSvc.scan).toHaveBeenCalledWith("company-1", [
      "idle_agent",
      "company_no_routines",
    ]);
  });

  it("blocks cross-company reads", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/companies/company-2/structural-findings"),
    );
    expect(res.status).toBe(403);
    expect(mockSvc.scan).not.toHaveBeenCalled();
  });

  it("permits a portfolio-root user to read another company", async () => {
    mockSvc.scan.mockResolvedValue([]);
    const app = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
      isPortfolioRootUserAdmin: true,
    });
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/companies/company-2/structural-findings"),
    );
    expect(res.status).toBe(200);
    expect(mockSvc.scan).toHaveBeenCalledWith("company-2", undefined);
  });
});
