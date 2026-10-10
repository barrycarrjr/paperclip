import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDesiredSkillEntry } from "@paperclipai/shared";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
}));
const mockBudgetService = vi.hoisted(() => ({}));
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({}));
const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));
const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockAgentInstructionsService = vi.hoisted(() => ({
  getBundle: vi.fn(),
  readFile: vi.fn(),
  updateBundle: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  exportFiles: vi.fn(),
  ensureManagedBundle: vi.fn(),
  materializeManagedBundle: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  resolveAdapterConfigForRuntime: vi.fn(),
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockSyncInstructionsBundleConfigFromFilePath = vi.hoisted(() => vi.fn());

const mockAdapter = vi.hoisted(() => ({
  listSkills: vi.fn(),
  syncSkills: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  companySkillService: () => mockCompanySkillService,
  budgetService: () => mockBudgetService,
  environmentService: () => mockEnvironmentService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

vi.mock("../adapters/index.js", () => ({
  findServerAdapter: vi.fn(() => mockAdapter),
  findActiveServerAdapter: vi.fn(() => mockAdapter),
  listAdapterModels: vi.fn(),
  detectAdapterModel: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => mockAgentInstructionsService,
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    companySkillService: () => mockCompanySkillService,
    budgetService: () => mockBudgetService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    issueService: () => ({}),
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
    syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
    workspaceOperationService: () => mockWorkspaceOperationService,
  }));

  vi.doMock("../adapters/index.js", () => ({
    findServerAdapter: vi.fn(() => mockAdapter),
    findActiveServerAdapter: vi.fn(() => mockAdapter),
    listAdapterModels: vi.fn(),
    detectAdapterModel: vi.fn(),
  }));
}

function createDb(requireBoardApprovalForNewAgents = false) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [
          {
            id: "company-1",
            requireBoardApprovalForNewAgents,
          },
        ]),
      })),
    })),
  };
}

async function createApp(db: Record<string, unknown> = createDb()) {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", agentRoutes(db as any));
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

function makeAgent(adapterType: string) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    name: "Agent",
    role: "engineer",
    title: "Engineer",
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType,
    adapterConfig: {},
    runtimeConfig: {},
    defaultEnvironmentId: null,
    permissions: null,
    updatedAt: new Date(),
  };
}

describe.sequential("agent skill routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    for (const mock of Object.values(mockAgentService)) mock.mockReset();
    for (const mock of Object.values(mockAccessService)) mock.mockReset();
    for (const mock of Object.values(mockApprovalService)) mock.mockReset();
    for (const mock of Object.values(mockIssueApprovalService)) mock.mockReset();
    for (const mock of Object.values(mockAgentInstructionsService)) mock.mockReset();
    for (const mock of Object.values(mockCompanySkillService)) mock.mockReset();
    for (const mock of Object.values(mockSecretService)) mock.mockReset();
    mockLogActivity.mockReset();
    mockSyncInstructionsBundleConfigFromFilePath.mockReset();
    mockAdapter.listSkills.mockReset();
    mockAdapter.syncSkills.mockReset();
    mockSyncInstructionsBundleConfigFromFilePath.mockImplementation((_agent, config) => config);
    let persistedAgent: Record<string, unknown> | null = null;
    mockAgentService.resolveByReference.mockResolvedValue({
      ambiguous: false,
      agent: makeAgent("claude_local"),
    });
    mockSecretService.resolveAdapterConfigForRuntime.mockResolvedValue({ config: { env: {} } });
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([
      {
        key: "paperclipai/paperclip/paperclip",
        runtimeName: "paperclip",
        source: "/tmp/paperclip",
        required: true,
        requiredReason: "required",
      },
    ]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockImplementation(
      async (_companyId: string, requested: string[]) =>
        requested.map((value) =>
          value === "paperclip"
            ? "paperclipai/paperclip/paperclip"
            : value,
        ),
    );
    mockAdapter.listSkills.mockResolvedValue({
      adapterType: "claude_local",
      supported: true,
      mode: "ephemeral",
      desiredSkills: ["paperclipai/paperclip/paperclip"],
      entries: [],
      warnings: [],
    });
    mockAdapter.syncSkills.mockResolvedValue({
      adapterType: "claude_local",
      supported: true,
      mode: "ephemeral",
      desiredSkills: ["paperclipai/paperclip/paperclip"],
      entries: [],
      warnings: [],
    });
    mockAgentService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
      const previousAgent = persistedAgent ?? makeAgent("claude_local");
      persistedAgent = {
        ...previousAgent,
        ...patch,
        adapterConfig: patch.adapterConfig ?? previousAgent.adapterConfig ?? {},
      };
      return persistedAgent;
    });
    mockAgentService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => {
      persistedAgent = {
        ...makeAgent(String(input.adapterType ?? "claude_local")),
        ...input,
        adapterConfig: input.adapterConfig ?? {},
        runtimeConfig: input.runtimeConfig ?? {},
        budgetMonthlyCents: Number(input.budgetMonthlyCents ?? 0),
        permissions: null,
      };
      return persistedAgent;
    });
    mockApprovalService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: input.payload ?? {},
    }));
    mockAgentInstructionsService.materializeManagedBundle.mockImplementation(
      async (agent: Record<string, unknown>, files: Record<string, string>) => ({
        bundle: null,
        adapterConfig: {
          ...((agent.adapterConfig as Record<string, unknown> | undefined) ?? {}),
          instructionsBundleMode: "managed",
          instructionsRootPath: `/tmp/${String(agent.id)}/instructions`,
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: `/tmp/${String(agent.id)}/instructions/AGENTS.md`,
          promptTemplate: files["AGENTS.md"] ?? "",
        },
      }),
    );
    mockLogActivity.mockResolvedValue(undefined);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAccessService.getMembership.mockResolvedValue(null);
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
  });

  it("skips runtime materialization when listing Claude skills", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("claude_local"));

    const res = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl)
        .get("/api/agents/11111111-1111-4111-8111-111111111111/skills?companyId=company-1"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAdapter.listSkills).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterType: "claude_local",
        config: expect.objectContaining({
          paperclipRuntimeSkills: expect.any(Array),
        }),
      }),
    );
  }, 10_000);

  it("skips runtime materialization when listing Codex skills", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("codex_local"));
    mockAdapter.listSkills.mockResolvedValue({
      adapterType: "codex_local",
      supported: true,
      mode: "ephemeral",
      desiredSkills: ["paperclipai/paperclip/paperclip"],
      entries: [],
      warnings: [],
    });

    const res = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl)
        .get("/api/agents/11111111-1111-4111-8111-111111111111/skills?companyId=company-1"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("keeps runtime materialization for persistent skill adapters", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("cursor"));
    mockAdapter.listSkills.mockResolvedValue({
      adapterType: "cursor",
      supported: true,
      mode: "persistent",
      desiredSkills: ["paperclipai/paperclip/paperclip"],
      entries: [],
      warnings: [],
    });

    const res = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl)
        .get("/api/agents/11111111-1111-4111-8111-111111111111/skills?companyId=company-1"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("skips runtime materialization when syncing Claude skills", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("claude_local"));

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/agents/11111111-1111-4111-8111-111111111111/skills/sync?companyId=company-1")
      .send({ desiredSkills: ["paperclipai/paperclip/paperclip"] }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAdapter.syncSkills).toHaveBeenCalled();
  });

  it("canonicalizes desired skill references before syncing", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("claude_local"));

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/agents/11111111-1111-4111-8111-111111111111/skills/sync?companyId=company-1")
      .send({ desiredSkills: ["paperclip"] }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          paperclipSkillSync: expect.objectContaining({
            desiredSkills: ["paperclipai/paperclip/paperclip"],
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  describe("sync modes", () => {
    const currentSkills = [
      "paperclipai/paperclip/paperclip",
      "company/company-1/review",
      "company/company-1/deploy",
    ];
    // The library the real resolver matches against. Two skills share the
    // short name "review".
    const library = [
      { id: "skill-1", key: "paperclipai/paperclip/paperclip", slug: "paperclip" },
      { id: "skill-2", key: "company/company-1/review", slug: "review" },
      { id: "skill-3", key: "company/company-1/deploy", slug: "deploy" },
      { id: "skill-4", key: "company/company-1/triage", slug: "triage" },
      { id: "skill-5", key: "acme/skills/review", slug: "review" },
    ];

    function givenSavedSkills(desiredSkills: string[]) {
      mockAgentService.getById.mockResolvedValue({
        ...makeAgent("claude_local"),
        adapterConfig: { paperclipSkillSync: { desiredSkills } },
      });
    }

    function storedDesiredSkills() {
      const patch = mockAgentService.update.mock.calls.at(-1)?.[1] as
        | { adapterConfig?: { paperclipSkillSync?: { desiredSkills?: unknown } } }
        | undefined;
      return patch?.adapterConfig?.paperclipSkillSync?.desiredSkills;
    }

    async function sync(body: Record<string, unknown>) {
      return requestApp(await createApp(), (baseUrl) => request(baseUrl)
        .post("/api/agents/11111111-1111-4111-8111-111111111111/skills/sync?companyId=company-1")
        .send(body));
    }

    beforeEach(() => {
      givenSavedSkills(currentSkills);
      mockCompanySkillService.resolveRequestedSkillKeys.mockImplementation(
        async (
          _companyId: string,
          requested: Array<string | AgentDesiredSkillEntry>,
          options?: { keepUnresolved?: string[] },
        ) => {
          // Loaded here so its errors come from the same module as the route's.
          const { resolveRequestedSkillKeysOrThrow } = await import("../services/company-skills.js");
          return resolveRequestedSkillKeysOrThrow(library, requested, options);
        },
      );
    });

    it.each([
      ["plain keys", ["company/company-1/triage"]],
      ["skill entries", [{ key: "company/company-1/triage", versionId: null }]],
    ])("replaces the whole set with %s", async (_label, desiredSkills) => {
      const res = await sync({ mode: "replace", desiredSkills });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(storedDesiredSkills()).toEqual([
        "paperclipai/paperclip/paperclip",
        "company/company-1/triage",
      ]);
    });

    it.each([
      ["plain keys", ["company/company-1/triage"]],
      ["skill entries", [{ key: "company/company-1/triage", versionId: null }]],
    ])("adds %s to the current set", async (_label, desiredSkills) => {
      const res = await sync({ mode: "add", desiredSkills });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(storedDesiredSkills()).toEqual([...currentSkills, "company/company-1/triage"]);
    });

    it.each([
      ["plain keys", ["company/company-1/review"]],
      ["skill entries", [{ key: "company/company-1/review", versionId: null }]],
    ])("removes %s from the current set", async (_label, desiredSkills) => {
      const res = await sync({ mode: "remove", desiredSkills });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(storedDesiredSkills()).toEqual([
        "paperclipai/paperclip/paperclip",
        "company/company-1/deploy",
      ]);
    });

    it("saves the dialog's full entry list and ignores version ids", async () => {
      const res = await sync({
        mode: "replace",
        desiredSkills: [
          ...currentSkills.map((key) => ({ key, versionId: null })),
          { key: "company/company-1/triage", versionId: "33333333-3333-4333-8333-333333333333" },
        ],
      });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(storedDesiredSkills()).toEqual([...currentSkills, "company/company-1/triage"]);
    });

    it("replaces the set when no mode is sent", async () => {
      const res = await sync({ desiredSkills: ["company/company-1/triage"] });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(storedDesiredSkills()).toEqual([
        "paperclipai/paperclip/paperclip",
        "company/company-1/triage",
      ]);
    });

    describe("when the agent has a skill that is no longer in the library", () => {
      const savedSkills = [...currentSkills, "company/company-1/retired"];

      beforeEach(() => {
        givenSavedSkills(savedSkills);
      });

      // The agents dialog sends the agent's whole list back with one change.
      it("saves the dialog's list when adding a skill", async () => {
        const res = await sync({
          mode: "replace",
          desiredSkills: [...savedSkills, "company/company-1/triage"].map((key) => ({ key, versionId: null })),
        });

        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(storedDesiredSkills()).toEqual([...savedSkills, "company/company-1/triage"]);
      });

      it("saves the dialog's list when removing a skill", async () => {
        const res = await sync({
          mode: "replace",
          desiredSkills: savedSkills
            .filter((key) => key !== "company/company-1/review")
            .map((key) => ({ key, versionId: null })),
        });

        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(storedDesiredSkills()).toEqual([
          "paperclipai/paperclip/paperclip",
          "company/company-1/deploy",
          "company/company-1/retired",
        ]);
      });

      it.each([
        ["replace", savedSkills, savedSkills],
        ["add", ["company/company-1/retired"], savedSkills],
        ["remove", ["company/company-1/retired"], currentSkills],
      ])("accepts that key in %s mode", async (mode, desiredSkills, expected) => {
        const res = await sync({ mode, desiredSkills });

        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(storedDesiredSkills()).toEqual(expected);
      });

      it("matches that key whatever its case", async () => {
        givenSavedSkills([...currentSkills, "Company/Company-1/Retired"]);

        const res = await sync({ mode: "remove", desiredSkills: ["company/company-1/retired"] });

        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(storedDesiredSkills()).toEqual(currentSkills);
      });
    });

    it.each(["replace", "add", "remove"])("rejects a key in %s mode that is neither in the library nor on the agent", async (mode) => {
      const res = await sync({ mode, desiredSkills: [...currentSkills, "company/company-1/missing"] });

      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.error).toContain("unknown references: company/company-1/missing");
      expect(mockAgentService.update).not.toHaveBeenCalled();
    });

    describe("when the agent has a short name that two skills now share", () => {
      const savedSkills = ["paperclipai/paperclip/paperclip", "review", "company/company-1/deploy"];

      beforeEach(() => {
        givenSavedSkills(savedSkills);
      });

      it("adds a skill and keeps the short name", async () => {
        const res = await sync({ mode: "add", desiredSkills: ["company/company-1/triage"] });

        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(storedDesiredSkills()).toEqual([...savedSkills, "company/company-1/triage"]);
      });

      it("removes a skill and keeps the short name", async () => {
        const res = await sync({ mode: "remove", desiredSkills: ["company/company-1/deploy"] });

        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(storedDesiredSkills()).toEqual(["paperclipai/paperclip/paperclip", "review"]);
      });

      it("removes the short name itself", async () => {
        const res = await sync({ mode: "remove", desiredSkills: ["review"] });

        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(storedDesiredSkills()).toEqual(["paperclipai/paperclip/paperclip", "company/company-1/deploy"]);
      });

      it("saves the agents dialog's whole list", async () => {
        const res = await sync({
          mode: "replace",
          desiredSkills: [...savedSkills, "company/company-1/triage"].map((key) => ({ key, versionId: null })),
        });

        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(storedDesiredSkills()).toEqual([...savedSkills, "company/company-1/triage"]);
      });
    });

    it("rejects a shared short name the agent does not have", async () => {
      const res = await sync({ mode: "add", desiredSkills: ["review"] });

      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.error).toContain("ambiguous references: review");
      expect(mockAgentService.update).not.toHaveBeenCalled();
    });
  });

  it("accepts skill entries when creating an agent directly", async () => {
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/agents")
      .send({
        name: "QA Agent",
        role: "engineer",
        adapterType: "claude_local",
        desiredSkills: [{ key: "paperclip", versionId: null }],
        adapterConfig: {},
      }));

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          paperclipSkillSync: expect.objectContaining({
            desiredSkills: ["paperclipai/paperclip/paperclip"],
          }),
        }),
      }),
    );
  });

  it("accepts skill entries in hire requests", async () => {
    const res = await request(await createApp(createDb(true)))
      .post("/api/companies/company-1/agent-hires")
      .send({
        name: "QA Agent",
        role: "engineer",
        adapterType: "claude_local",
        desiredSkills: [{ key: "paperclip", versionId: "33333333-3333-4333-8333-333333333333" }],
        adapterConfig: {},
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        payload: expect.objectContaining({
          desiredSkills: ["paperclipai/paperclip/paperclip"],
        }),
      }),
    );
  });

  it("persists canonical desired skills when creating an agent directly", async () => {
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/agents")
      .send({
        name: "QA Agent",
        role: "engineer",
        adapterType: "claude_local",
        desiredSkills: ["paperclip"],
        adapterConfig: {},
      }));

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          paperclipSkillSync: expect.objectContaining({
            desiredSkills: ["paperclipai/paperclip/paperclip"],
          }),
        }),
      }),
    );
  });

  it("accepts the security role on direct agent creation", async () => {
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/agents")
      .send({
        name: "Security Engineer",
        role: "security",
        adapterType: "claude_local",
        adapterConfig: {},
      }));

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(res.body).toMatchObject({
      role: "security",
    });
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        role: "security",
      }),
    );
  });

  it("materializes a managed AGENTS.md for directly created local agents", async () => {
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/agents")
      .send({
        name: "QA Agent",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {
          promptTemplate: "You are QA.",
        },
      }));

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          instructionsBundleMode: "managed",
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: "/tmp/11111111-1111-4111-8111-111111111111/instructions/AGENTS.md",
        }),
      }),
    );
    expect(mockAgentService.update.mock.calls.at(-1)?.[1]).not.toMatchObject({
      adapterConfig: expect.objectContaining({
        promptTemplate: expect.anything(),
      }),
    });
  });

  it("materializes the bundled CEO instruction set for default CEO agents", async () => {
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/agents")
      .send({
        name: "CEO",
        role: "ceo",
        adapterType: "claude_local",
        adapterConfig: {},
      }));

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockAgentInstructionsService.materializeManagedBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "11111111-1111-4111-8111-111111111111",
        role: "ceo",
        adapterType: "claude_local",
      }),
      expect.objectContaining({
        "AGENTS.md": expect.stringContaining("You are the CEO."),
        "HEARTBEAT.md": expect.stringContaining("CEO Heartbeat Checklist"),
        "SOUL.md": expect.stringContaining("CEO Persona"),
        "TOOLS.md": expect.stringContaining("# Tools"),
      }),
      { entryFile: "AGENTS.md", replaceExisting: false },
    );
  });

  it("materializes the bundled default instruction set for non-CEO agents with no prompt template", async () => {
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/agents")
      .send({
        name: "Engineer",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {},
      }));

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    await vi.waitFor(() => {
      expect(mockAgentInstructionsService.materializeManagedBundle).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "11111111-1111-4111-8111-111111111111",
          role: "engineer",
          adapterType: "claude_local",
        }),
        expect.objectContaining({
          "AGENTS.md": expect.stringMatching(/Start actionable work in the same heartbeat\.[\s\S]*Keep the work moving until it is done\./),
        }),
        { entryFile: "AGENTS.md", replaceExisting: false },
      );
      expect(mockAgentInstructionsService.materializeManagedBundle).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          "AGENTS.md": expect.stringContaining('kind: "request_confirmation"'),
        }),
        expect.any(Object),
      );
      expect(mockAgentInstructionsService.materializeManagedBundle).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          "AGENTS.md": expect.stringContaining("confirmation:{issueId}:plan:{revisionId}"),
        }),
        expect.any(Object),
      );
    });
  });

  it("includes canonical desired skills in hire approvals", async () => {
    const db = createDb(true);

    const res = await request(await createApp(db))
      .post("/api/companies/company-1/agent-hires")
      .send({
        name: "QA Agent",
        role: "engineer",
        adapterType: "claude_local",
        desiredSkills: ["paperclip"],
        adapterConfig: {},
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        payload: expect.objectContaining({
          desiredSkills: ["paperclipai/paperclip/paperclip"],
          requestedConfigurationSnapshot: expect.objectContaining({
            desiredSkills: ["paperclipai/paperclip/paperclip"],
          }),
        }),
      }),
    );
  });

  it("preserves hire source issues, icons, desired skills, and approval payload details", async () => {
    const db = createDb(true);
    const sourceIssueId = "22222222-2222-4222-8222-222222222222";

    const res = await request(await createApp(db))
      .post("/api/companies/company-1/agent-hires")
      .send({
        name: "Security Engineer",
        role: "engineer",
        icon: "crown",
        adapterType: "claude_local",
        desiredSkills: ["paperclip"],
        adapterConfig: {},
        sourceIssueId,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        icon: "crown",
        adapterConfig: expect.objectContaining({
          paperclipSkillSync: expect.objectContaining({
            desiredSkills: ["paperclipai/paperclip/paperclip"],
          }),
        }),
      }),
    );
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        payload: expect.objectContaining({
          icon: "crown",
          desiredSkills: ["paperclipai/paperclip/paperclip"],
          requestedConfigurationSnapshot: expect.objectContaining({
            desiredSkills: ["paperclipai/paperclip/paperclip"],
          }),
        }),
      }),
    );
    expect(mockIssueApprovalService.linkManyForApproval).toHaveBeenCalledWith(
      "approval-1",
      [sourceIssueId],
      { agentId: null, userId: "local-board" },
    );
  });

  it("uses managed AGENTS config in hire approval payloads", async () => {
    const res = await request(await createApp(createDb(true)))
      .post("/api/companies/company-1/agent-hires")
      .send({
        name: "QA Agent",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {
          promptTemplate: "You are QA.",
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        payload: expect.objectContaining({
          adapterConfig: expect.objectContaining({
            instructionsBundleMode: "managed",
            instructionsEntryFile: "AGENTS.md",
            instructionsFilePath: "/tmp/11111111-1111-4111-8111-111111111111/instructions/AGENTS.md",
          }),
        }),
      }),
    );
    const approvalInput = mockApprovalService.create.mock.calls.at(-1)?.[1] as
      | { payload?: { adapterConfig?: Record<string, unknown> } }
      | undefined;
    expect(approvalInput?.payload?.adapterConfig?.promptTemplate).toBeUndefined();
  });
});
