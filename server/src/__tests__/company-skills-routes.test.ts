import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  importFromSource: vi.fn(),
  scanProjectWorkspaces: vi.fn(),
  deleteSkill: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));

  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  // The real source parser, so the route tells local and remote sources apart
  // exactly as the service does.
  vi.doMock("../services/company-skills.js", async () => ({
    ...await vi.importActual<typeof import("../services/company-skills.js")>("../services/company-skills.js"),
    companySkillService: () => mockCompanySkillService,
  }));

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    companySkillService: () => mockCompanySkillService,
    logActivity: mockLogActivity,
  }));
}

async function createApp(actor: Record<string, unknown>) {
  const [{ companySkillRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/company-skills.js")>("../routes/company-skills.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", companySkillRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("company skill mutation permissions", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/company-skills.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/company-skills.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockCompanySkillService.importFromSource.mockResolvedValue({
      imported: [],
      warnings: [],
    });
    mockCompanySkillService.scanProjectWorkspaces.mockResolvedValue({
      scannedProjects: 0,
      scannedWorkspaces: 0,
      discovered: 0,
      imported: [],
      updated: [],
      skipped: [],
      conflicts: [],
      warnings: [],
    });
    mockCompanySkillService.deleteSkill.mockResolvedValue({
      id: "skill-1",
      slug: "find-skills",
      name: "Find Skills",
    });
    mockLogActivity.mockResolvedValue(undefined);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(false);
  });

  it("allows local board operators to mutate company skills", async () => {
    const res = await request(await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(res.body).toEqual({
      imported: [],
      warnings: [],
    });
  });

  it("blocks same-company agents without management permission from mutating company skills", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      permissions: {},
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    }))
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockCompanySkillService.importFromSource).not.toHaveBeenCalled();
  });

  it("allows agents with canCreateAgents to mutate company skills", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      permissions: { canCreateAgents: true },
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    }))
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockCompanySkillService.importFromSource).toHaveBeenCalledWith(
      "company-1",
      "https://github.com/vercel-labs/agent-browser",
    );
  });

  it("returns a blocking error when attempting to delete a skill still used by agents", async () => {
    const { unprocessable } = await import("../errors.js");
    mockCompanySkillService.deleteSkill.mockImplementationOnce(async () => {
      throw unprocessable(
        'Cannot delete skill "Find Skills" while it is still used by Builder, Reviewer. Detach it from those agents first.',
      );
    });

    const res = await request(await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .delete("/api/companies/company-1/skills/skill-1");

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body).toEqual({
      error: 'Cannot delete skill "Find Skills" while it is still used by Builder, Reviewer. Detach it from those agents first.',
    });
    expect(mockCompanySkillService.deleteSkill).toHaveBeenCalledWith("company-1", "skill-1");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  describe("bringing skills in from folders on this computer", () => {
    const member = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "operator", status: "active" }],
      source: "session",
      isInstanceAdmin: false,
    };
    const companyOwner = {
      ...member,
      memberships: [{ companyId: "company-1", membershipRole: "owner", status: "active" }],
    };
    const instanceAdmin = { ...member, userId: "admin-1", isInstanceAdmin: true };
    const localBoard = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    const agent = { type: "agent", agentId: "agent-1", companyId: "company-1", runId: "run-1", source: "agent_key" };
    const notAdmins = [
      ["a member who can manage skills", member],
      ["a company owner", companyOwner],
      ["an agent that can create agents", agent],
    ] as const;
    const admins = [
      ["an instance admin", instanceAdmin],
      ["the local board", localBoard],
    ] as const;
    const localSources = [
      "C:\\skills\\release-notes",
      "/srv/skills/release-notes",
      "release-notes",
      "\\\\server\\share\\skills",
      "npx skills add /srv/skills/release-notes --skill release-notes",
    ];
    const remoteSources = [
      "https://github.com/vercel-labs/agent-browser",
      "vercel-labs/agent-browser",
      "google-labs-code/stitch-skills/design-md",
      "https://skills.sh/google-labs-code/stitch-skills/design-md",
      "npx skills add https://github.com/vercel-labs/agent-browser --skill agent-browser",
    ];

    beforeEach(() => {
      mockAgentService.getById.mockResolvedValue({
        id: "agent-1",
        companyId: "company-1",
        permissions: { canCreateAgents: true },
      });
    });

    it.each(notAdmins)("refuses a local path import from %s", async (_label, actor) => {
      const app = await createApp(actor);
      for (const source of localSources) {
        const res = await request(app).post("/api/companies/company-1/skills/import").send({ source });
        expect(res.status, `${source}: ${JSON.stringify(res.body)}`).toBe(403);
        expect(res.body).toMatchObject({
          error: "Only an instance admin can import skills from folders on this computer.",
          code: "skill_local_import_admin_required",
        });
      }
      expect(mockCompanySkillService.importFromSource).not.toHaveBeenCalled();
    });

    it.each(notAdmins)("still lets %s import from a URL, GitHub or skills.sh", async (_label, actor) => {
      const app = await createApp(actor);
      for (const source of remoteSources) {
        const res = await request(app).post("/api/companies/company-1/skills/import").send({ source });
        expect(res.status, `${source}: ${JSON.stringify(res.body)}`).toBe(201);
        expect(mockCompanySkillService.importFromSource).toHaveBeenLastCalledWith("company-1", source);
      }
    });

    it.each(admins)("lets %s import from a folder on this computer", async (_label, actor) => {
      const app = await createApp(actor);
      for (const source of localSources) {
        const res = await request(app).post("/api/companies/company-1/skills/import").send({ source });
        expect(res.status, `${source}: ${JSON.stringify(res.body)}`).toBe(201);
        expect(mockCompanySkillService.importFromSource).toHaveBeenLastCalledWith("company-1", source);
      }
    });

    it.each(notAdmins)("refuses a project scan from %s", async (_label, actor) => {
      const res = await request(await createApp(actor))
        .post("/api/companies/company-1/skills/scan-projects")
        .send({});

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body).toMatchObject({ code: "skill_local_import_admin_required" });
      expect(mockCompanySkillService.scanProjectWorkspaces).not.toHaveBeenCalled();
    });

    it.each(admins)("lets %s scan project workspaces", async (_label, actor) => {
      const res = await request(await createApp(actor))
        .post("/api/companies/company-1/skills/scan-projects")
        .send({});

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockCompanySkillService.scanProjectWorkspaces).toHaveBeenCalledWith("company-1", {});
    });
  });
});
