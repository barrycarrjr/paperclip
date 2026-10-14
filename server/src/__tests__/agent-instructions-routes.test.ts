import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

const mockAgentService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  resolveByReference: vi.fn(),
}));

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

const mockAccessService = vi.hoisted(() => ({
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  resolveAdapterConfigForRuntime: vi.fn(),
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
}));
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockSyncInstructionsBundleConfigFromFilePath = vi.hoisted(() => vi.fn());
const mockFindServerAdapter = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => ({}),
  companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
  budgetService: () => ({}),
  environmentService: () => mockEnvironmentService,
  heartbeatService: () => ({}),
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
  workspaceOperationService: () => ({}),
}));

vi.mock("../adapters/index.js", () => ({
  findActiveServerAdapter: () => null,
  findServerAdapter: mockFindServerAdapter,
  listAdapterModels: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => mockAgentInstructionsService,
    accessService: () => mockAccessService,
    approvalService: () => ({}),
    companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
    budgetService: () => ({}),
    heartbeatService: () => ({}),
    issueApprovalService: () => ({}),
    issueService: () => ({}),
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
    syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
    workspaceOperationService: () => ({}),
  }));

  vi.doMock("../adapters/index.js", () => ({
    // Null sends PATCH instructions-path to its built-in path keys.
    findActiveServerAdapter: () => null,
    findServerAdapter: mockFindServerAdapter,
    listAdapterModels: vi.fn(),
  }));
}

const LOCAL_BOARD = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
};

async function createApp(actor: Record<string, unknown> = LOCAL_BOARD, db: unknown = {}) {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { ...actor };
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

function makeAgent() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    name: "Agent",
    role: "engineer",
    title: "Engineer",
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    defaultEnvironmentId: null,
    permissions: null,
    updatedAt: new Date(),
  };
}

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
// Any folder on the host other than Paperclip's own managed one.
const OUTSIDE_ROOT = path.resolve("/srv/team-instructions");

function managedInstructionsRoot() {
  return path.resolve(resolvePaperclipInstanceRoot(), "companies", "company-1", "agents", AGENT_ID, "instructions");
}

function makeAgentWithInstructions(mode: "managed" | "external", rootPath: string) {
  return {
    ...makeAgent(),
    adapterConfig: {
      instructionsBundleMode: mode,
      instructionsRootPath: rootPath,
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: path.join(rootPath, "AGENTS.md"),
    },
  };
}

// Holds agents:create (the mocked canUser answers yes), which is what reading
// another agent's instructions needs, but is not an instance admin.
const COMPANY_MEMBER = {
  type: "board",
  userId: "user-1",
  companyIds: ["company-1"],
  source: "session",
  isInstanceAdmin: false,
};
const INSTANCE_ADMIN = { ...COMPANY_MEMBER, userId: "admin-1", isInstanceAdmin: true };
const SAME_AGENT = { type: "agent", agentId: AGENT_ID, companyId: "company-1", source: "agent_key" };
const EXTERNAL_REFUSAL = "Only an instance admin can open or change instructions kept outside Paperclip.";
const PATH_REFUSAL = "Instructions file path must stay within the bundle root";

describe("agent instructions bundle routes", () => {
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;
  const originalPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  beforeEach(() => {
    // The routes look for the managed folder on disk, so point the instance
    // somewhere of its own rather than at the real one.
    process.env.PAPERCLIP_HOME = path.join(os.tmpdir(), "paperclip-agent-instructions-routes-home");
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
    vi.resetModules();
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockAccessService.canUser.mockReset();
    mockAgentInstructionsService.deleteFile.mockReset();
    mockSyncInstructionsBundleConfigFromFilePath.mockImplementation((_agent, config) => config);
    mockFindServerAdapter.mockImplementation((_type: string) => ({ type: _type }));
    mockAgentService.getById.mockResolvedValue(makeAgent());
    mockAgentService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeAgent(),
      adapterConfig: patch.adapterConfig ?? {},
    }));
    mockAgentInstructionsService.getBundle.mockResolvedValue({
      agentId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      mode: "managed",
      rootPath: "/tmp/agent-1",
      managedRootPath: "/tmp/agent-1",
      entryFile: "AGENTS.md",
      resolvedEntryPath: "/tmp/agent-1/AGENTS.md",
      editable: true,
      warnings: [],
      legacyPromptTemplateActive: false,
      legacyBootstrapPromptTemplateActive: false,
      files: [{
        path: "AGENTS.md",
        size: 12,
        language: "markdown",
        markdown: true,
        isEntryFile: true,
        editable: true,
        deprecated: false,
        virtual: false,
      }],
    });
    mockAgentInstructionsService.readFile.mockResolvedValue({
      path: "AGENTS.md",
      size: 12,
      language: "markdown",
      markdown: true,
      isEntryFile: true,
      editable: true,
      deprecated: false,
      virtual: false,
      content: "# Agent\n",
    });
    mockAgentInstructionsService.writeFile.mockResolvedValue({
      bundle: null,
      file: {
        path: "AGENTS.md",
        size: 18,
        language: "markdown",
        markdown: true,
        isEntryFile: true,
        editable: true,
        deprecated: false,
        virtual: false,
        content: "# Updated Agent\n",
      },
      adapterConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: "/tmp/agent-1",
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: "/tmp/agent-1/AGENTS.md",
      },
    });
  });

  afterEach(() => {
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
    if (originalPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalPaperclipInstanceId;
  });

  it("returns bundle metadata", async () => {
    const res = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl)
        .get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle?companyId=company-1"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      mode: "managed",
      rootPath: "/tmp/agent-1",
      managedRootPath: "/tmp/agent-1",
      entryFile: "AGENTS.md",
    });
    expect(mockAgentInstructionsService.getBundle).toHaveBeenCalled();
  });

  describe("new-agent tiered onboarding through the API", () => {
    let temporaryHome: string;
    let created: ReturnType<typeof makeAgent>;
    const creationDb = {
      select: () => ({ from: () => ({ where: () => Promise.resolve([{ id: "company-1", requireBoardApprovalForNewAgents: false }]) }) }),
    };

    beforeEach(async () => {
      temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-tiered-onboarding-"));
      process.env.PAPERCLIP_HOME = temporaryHome;
      const { agentInstructionsService } = await vi.importActual<typeof import("../services/agent-instructions.js")>("../services/agent-instructions.js");
      const real = agentInstructionsService();
      mockAgentInstructionsService.materializeManagedBundle.mockImplementation(real.materializeManagedBundle);
      mockAgentInstructionsService.getBundle.mockImplementation(real.getBundle);
      mockAgentInstructionsService.readFile.mockImplementation(real.readFile);
      mockAgentService.create.mockImplementation(async (_companyId, input) => {
        created = { ...makeAgent(), ...input };
        return created;
      });
      mockAgentService.update.mockImplementation(async (_id, patch) => {
        created = { ...created, ...patch };
        return created;
      });
      mockAgentService.getById.mockImplementation(async () => created);
    });

    afterEach(async () => {
      await fs.rm(temporaryHome, { recursive: true, force: true });
    });

    async function createAgent(role: string, adapterConfig: Record<string, unknown> = {}) {
      return requestApp(await createApp(LOCAL_BOARD, creationDb), (baseUrl) => request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({ name: "Tiered agent", role, adapterType: "codex_local", adapterConfig }));
    }

    it.each(["engineer", "ceo"])("materializes the %s core and serves every linked reference to its own agent", async (role) => {
      const creation = await createAgent(role);
      expect(creation.status, JSON.stringify(creation.body)).toBe(201);
      const ownApp = await createApp(SAME_AGENT);
      const core = await requestApp(ownApp, (baseUrl) => request(baseUrl)
        .get(`/api/agents/${AGENT_ID}/instructions-bundle/file`).query({ path: "AGENTS.md" }));
      expect(core.status, JSON.stringify(core.body)).toBe(200);
      const content: string = core.body.content;
      // Includes the full shared source-evidence instructions. Before tiering,
      // the default entry alone was 6,382 bytes; the CEO also required all three
      // companion files on every wake. These budgets are below those wake loads.
      expect(Buffer.byteLength(content)).toBeLessThan(role === "ceo" ? 7_000 : 6_382);
      expect(content).toContain("Core, read on every wake");
      expect(content).toContain("Read deeper only for the task");
      if (role === "ceo") expect(content).toContain("Above 80% spend");
      else expect(content).not.toContain("Above 80% spend");
      expect(content).toContain("Never expose secrets");
      expect(content).toContain("company access and permissions");
      expect(content).toContain("never retry a 409");
      expect(content).toContain("accepted confirmation bound to the latest plan revision");
      expect(content).toContain("stop the affected work and explain the missing access");
      expect(content).toContain("For each claim about money");
      expect(content).toContain("Not covered:");
      expect(content).not.toContain("These files are essential. Read them.");
      expect(content).not.toContain("## Strategic Posture");
      const references = [...new Set([...content.matchAll(/\]\(([^)#]+\.md)(?:#[^)]*)?\)/g)].map((match) => match[1]))];
      expect(references.length).toBe(role === "ceo" ? 8 : 4);
      for (const reference of references) {
        const response = await requestApp(ownApp, (baseUrl) => request(baseUrl)
          .get(`/api/agents/${AGENT_ID}/instructions-bundle/file`).query({ path: reference }));
        expect(response.status, `${reference}: ${JSON.stringify(response.body)}`).toBe(200);
        expect(response.body.content.length).toBeGreaterThan(100);
        for (const link of [...response.body.content.matchAll(/\]\(([^)#]+\.md)(?:#[^)]*)?\)/g)]) {
          const linkedPath = path.posix.normalize(path.posix.join(path.posix.dirname(reference), link[1]));
          const linked = await requestApp(ownApp, (baseUrl) => request(baseUrl)
            .get(`/api/agents/${AGENT_ID}/instructions-bundle/file`).query({ path: linkedPath }));
          expect(linked.status, `${reference} links ${linkedPath}: ${JSON.stringify(linked.body)}`).toBe(200);
        }
      }
      const memory = await requestApp(ownApp, (baseUrl) => request(baseUrl)
        .get(`/api/agents/${AGENT_ID}/instructions-bundle/file`).query({ path: "references/memory.md" }));
      expect(memory.body.content).toContain("Open an index only when the task needs discovery");
      expect(memory.body.content).toContain("A summary is a navigation aid");
      if (role === "ceo") {
        const heartbeat = await requestApp(ownApp, (baseUrl) => request(baseUrl)
          .get(`/api/agents/${AGENT_ID}/instructions-bundle/file`).query({ path: "HEARTBEAT.md" }));
        expect(heartbeat.body.content).not.toContain("Run this checklist on every heartbeat");
        expect(heartbeat.body.content).toContain("when new durable facts need storing");
      }
    });

    it("uses the same tiered bundle for the hire API", async () => {
      const creation = await requestApp(await createApp(LOCAL_BOARD, creationDb), (baseUrl) => request(baseUrl)
        .post("/api/companies/company-1/agent-hires")
        .send({ name: "New CEO", role: "ceo", adapterType: "codex_local" }));
      expect(creation.status, JSON.stringify(creation.body)).toBe(201);
      const app = await createApp(SAME_AGENT);
      const entry = await requestApp(app, (baseUrl) => request(baseUrl)
        .get(`/api/agents/${AGENT_ID}/instructions-bundle/file`).query({ path: "AGENTS.md" }));
      const routing = await requestApp(app, (baseUrl) => request(baseUrl)
        .get(`/api/agents/${AGENT_ID}/instructions-bundle/file`).query({ path: "references/leadership.md" }));
      expect(entry.status).toBe(200);
      expect(entry.body.content).toContain("Read deeper only for the task");
      expect(routing.status).toBe(200);
      expect(routing.body.content).toContain("technical tasks: CTO");
      expect(routing.body.content).toContain("CMO");
      expect(routing.body.content).toContain("UXDesigner");
    });

    it("materializes a custom prompt exactly, without adding core or references", async () => {
      const custom = "# Team instructions\nKeep our saved custom rules.\n";
      const creation = await createAgent("ceo", { promptTemplate: custom });
      expect(creation.status, JSON.stringify(creation.body)).toBe(201);
      const read = await requestApp(await createApp(SAME_AGENT), (baseUrl) => request(baseUrl)
        .get(`/api/agents/${AGENT_ID}/instructions-bundle/file`).query({ path: "AGENTS.md" }));
      expect(read.body.content).toBe(custom);
      const bundle = await requestApp(await createApp(SAME_AGENT), (baseUrl) => request(baseUrl)
        .get(`/api/agents/${AGENT_ID}/instructions-bundle`));
      expect(bundle.body.files.map((file: { path: string }) => file.path)).toEqual(["AGENTS.md"]);
    });

    it("keeps an explicitly saved managed bundle byte-identical", async () => {
      const rootPath = managedInstructionsRoot();
      await fs.mkdir(rootPath, { recursive: true });
      const saved = "# Existing rules\nNo replacement or extra references.\n";
      await fs.writeFile(path.join(rootPath, "AGENTS.md"), saved);
      const creation = await createAgent("ceo", {
        instructionsBundleMode: "managed", instructionsRootPath: rootPath,
        instructionsEntryFile: "AGENTS.md", instructionsFilePath: path.join(rootPath, "AGENTS.md"),
      });
      expect(creation.status, JSON.stringify(creation.body)).toBe(201);
      expect(mockAgentInstructionsService.materializeManagedBundle).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(rootPath, "AGENTS.md"), "utf8")).toBe(saved);
      expect(await fs.readdir(rootPath)).toEqual(["AGENTS.md"]);
    });

    it("refuses the managed reference fallback to an agent from another company", async () => {
      expect((await createAgent("engineer")).status).toBe(201);
      const foreign = { ...SAME_AGENT, companyId: "company-2" };
      const response = await requestApp(await createApp(foreign), (baseUrl) => request(baseUrl)
        .get(`/api/agents/${AGENT_ID}/instructions-bundle/file`).query({ path: "references/memory.md" }));
      expect(response.status).toBe(403);
    });
  });

  it("writes a bundle file and persists compatibility config", async () => {
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .put("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file?companyId=company-1")
      .send({
        path: "AGENTS.md",
        content: "# Updated Agent\n",
        clearLegacyPromptTemplate: true,
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentInstructionsService.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "11111111-1111-4111-8111-111111111111" }),
      "AGENTS.md",
      "# Updated Agent\n",
      { clearLegacyPromptTemplate: true },
    );
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          instructionsBundleMode: "managed",
          instructionsRootPath: "/tmp/agent-1",
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        }),
      }),
      expect.any(Object),
    );
  });

  it("preserves managed instructions config when switching adapters", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterType: "codex_local",
      adapterConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: "/tmp/agent-1",
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        model: "gpt-5.4",
      },
    });

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111?companyId=company-1")
      .send({
        adapterType: "claude_local",
        adapterConfig: {
          model: "claude-sonnet-4",
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        adapterType: "claude_local",
        adapterConfig: expect.objectContaining({
          model: "claude-sonnet-4",
          instructionsBundleMode: "managed",
          instructionsRootPath: "/tmp/agent-1",
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        }),
      }),
      expect.any(Object),
    );
  });

  it("merges same-adapter config patches so instructions metadata is not dropped", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterType: "codex_local",
      adapterConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: "/tmp/agent-1",
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        model: "gpt-5.4",
      },
    });

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111?companyId=company-1")
      .send({
        adapterConfig: {
          command: "codex --profile engineer",
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          command: "codex --profile engineer",
          model: "gpt-5.4",
          instructionsBundleMode: "managed",
          instructionsRootPath: "/tmp/agent-1",
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        }),
      }),
      expect.any(Object),
    );
  });

  it("replaces adapter config when replaceAdapterConfig is true", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterType: "codex_local",
      adapterConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: "/tmp/agent-1",
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        model: "gpt-5.4",
      },
    });

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111?companyId=company-1")
      .send({
        replaceAdapterConfig: true,
        adapterConfig: {
          command: "codex --profile engineer",
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.adapterConfig).toMatchObject({
      command: "codex --profile engineer",
    });
    expect(res.body.adapterConfig.instructionsBundleMode).toBeUndefined();
    expect(res.body.adapterConfig.instructionsRootPath).toBeUndefined();
    expect(res.body.adapterConfig.instructionsEntryFile).toBeUndefined();
    expect(res.body.adapterConfig.instructionsFilePath).toBeUndefined();
  });

  it("ai-rewrite answers 503 without touching a provider when pickOneShotModel finds no model", async () => {
    const pickOneShotModel = vi.fn(async () => null);
    const getProviderForModel = vi.fn();
    vi.doMock("../services/chat-providers.js", () => ({
      pickOneShotModel,
      getProviderForModel,
      removeClippyWorkspace: vi.fn(),
    }));

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file/ai-rewrite?companyId=company-1")
      .send({ path: "AGENTS.md", content: "# Agent\n", prompt: "Make it shorter" }));

    expect(res.status, JSON.stringify(res.body)).toBe(503);
    expect(res.body.error).toContain("No AI model is configured");
    expect(pickOneShotModel).toHaveBeenCalledTimes(1);
    expect(getProviderForModel).not.toHaveBeenCalled();
  });

  it("ai-rewrite uses the requested model and skips the cascade when one is named", async () => {
    const pickOneShotModel = vi.fn(async () => "claude-opus-4-7");
    const getProviderForModel = vi.fn(() => null);
    vi.doMock("../services/chat-providers.js", () => ({
      pickOneShotModel,
      getProviderForModel,
      removeClippyWorkspace: vi.fn(),
    }));

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file/ai-rewrite?companyId=company-1")
      .send({ path: "AGENTS.md", content: "# Agent\n", prompt: "Make it shorter", model: "gpt-4.1" }));

    expect(res.status, JSON.stringify(res.body)).toBe(503);
    expect(res.body.error).toContain('No provider available for model "gpt-4.1"');
    expect(pickOneShotModel).not.toHaveBeenCalled();
    expect(getProviderForModel).toHaveBeenCalledWith("gpt-4.1");
  });

  describe("reading instructions kept outside Paperclip's own storage", () => {
    const fileUrl = `/api/agents/${AGENT_ID}/instructions-bundle/file?companyId=company-1&path=AGENTS.md`;
    const bundleUrl = `/api/agents/${AGENT_ID}/instructions-bundle?companyId=company-1`;

    beforeEach(() => {
      mockAccessService.canUser.mockResolvedValue(true);
    });

    it("refuses a member who is not an instance admin the file and the file list", async () => {
      mockAgentService.getById.mockResolvedValue(makeAgentWithInstructions("external", OUTSIDE_ROOT));
      const app = await createApp(COMPANY_MEMBER);

      const file = await requestApp(app, (baseUrl) => request(baseUrl).get(fileUrl));
      expect(file.status, JSON.stringify(file.body)).toBe(403);
      expect(file.body).toEqual({ error: EXTERNAL_REFUSAL });

      const bundle = await requestApp(app, (baseUrl) => request(baseUrl).get(bundleUrl));
      expect(bundle.status, JSON.stringify(bundle.body)).toBe(403);

      expect(mockAgentInstructionsService.readFile).not.toHaveBeenCalled();
      expect(mockAgentInstructionsService.getBundle).not.toHaveBeenCalled();
    });

    it("treats a folder outside Paperclip as outside even when the saved mode says managed", async () => {
      mockAgentService.getById.mockResolvedValue(makeAgentWithInstructions("managed", OUTSIDE_ROOT));

      const res = await requestApp(await createApp(COMPANY_MEMBER), (baseUrl) => request(baseUrl).get(fileUrl));

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockAgentInstructionsService.readFile).not.toHaveBeenCalled();
    });

    it("refuses an agent, even reading its own instructions", async () => {
      mockAgentService.getById.mockResolvedValue(makeAgentWithInstructions("external", OUTSIDE_ROOT));
      const app = await createApp(SAME_AGENT);

      const file = await requestApp(app, (baseUrl) => request(baseUrl).get(fileUrl));
      expect(file.status, JSON.stringify(file.body)).toBe(403);
      const bundle = await requestApp(app, (baseUrl) => request(baseUrl).get(bundleUrl));
      expect(bundle.status, JSON.stringify(bundle.body)).toBe(403);

      expect(mockAgentInstructionsService.readFile).not.toHaveBeenCalled();
      expect(mockAgentInstructionsService.getBundle).not.toHaveBeenCalled();
    });

    it("lets an instance admin and the local board read it", async () => {
      mockAgentService.getById.mockResolvedValue(makeAgentWithInstructions("external", OUTSIDE_ROOT));

      for (const actor of [INSTANCE_ADMIN, LOCAL_BOARD]) {
        const app = await createApp(actor);
        const file = await requestApp(app, (baseUrl) => request(baseUrl).get(fileUrl));
        expect(file.status, JSON.stringify(file.body)).toBe(200);
        const bundle = await requestApp(app, (baseUrl) => request(baseUrl).get(bundleUrl));
        expect(bundle.status, JSON.stringify(bundle.body)).toBe(200);
      }
      expect(mockAgentInstructionsService.readFile).toHaveBeenCalledTimes(2);
    });

    it("keeps the usual read rule for Paperclip's own managed folder", async () => {
      mockAgentService.getById.mockResolvedValue(makeAgentWithInstructions("managed", managedInstructionsRoot()));

      for (const actor of [COMPANY_MEMBER, SAME_AGENT]) {
        const app = await createApp(actor);
        const file = await requestApp(app, (baseUrl) => request(baseUrl).get(fileUrl));
        expect(file.status, JSON.stringify(file.body)).toBe(200);
        expect(file.body).toMatchObject({ path: "AGENTS.md", content: "# Agent\n" });
        const bundle = await requestApp(app, (baseUrl) => request(baseUrl).get(bundleUrl));
        expect(bundle.status, JSON.stringify(bundle.body)).toBe(200);
      }
      expect(mockAgentInstructionsService.readFile).toHaveBeenCalledTimes(2);
    });
  });

  describe("changing instructions kept outside Paperclip's own storage", () => {
    const query = { companyId: "company-1" };
    const bundleUrl = `/api/agents/${AGENT_ID}/instructions-bundle`;
    const fileUrl = `/api/agents/${AGENT_ID}/instructions-bundle/file`;
    const pathUrl = `/api/agents/${AGENT_ID}/instructions-path`;

    beforeEach(async () => {
      mockAccessService.canUser.mockResolvedValue(true);
      // The real sync, so a changed file path turns into the bundle settings
      // it does on the live server.
      const actual = await vi.importActual<typeof import("../services/agent-instructions.js")>(
        "../services/agent-instructions.js",
      );
      mockSyncInstructionsBundleConfigFromFilePath.mockImplementation(actual.syncInstructionsBundleConfigFromFilePath);
      mockAgentInstructionsService.updateBundle.mockResolvedValue({
        bundle: { mode: "external", rootPath: OUTSIDE_ROOT, entryFile: "AGENTS.md", files: [] },
        adapterConfig: makeAgentWithInstructions("external", OUTSIDE_ROOT).adapterConfig,
      });
      mockAgentInstructionsService.deleteFile.mockResolvedValue({
        bundle: { mode: "external", rootPath: OUTSIDE_ROOT, entryFile: "AGENTS.md", files: [] },
        adapterConfig: makeAgentWithInstructions("external", OUTSIDE_ROOT).adapterConfig,
      });
    });

    it("refuses a member switching an outside folder to managed, which copies its files in", async () => {
      mockAgentService.getById.mockResolvedValue(makeAgentWithInstructions("external", OUTSIDE_ROOT));

      const res = await requestApp(await createApp(COMPANY_MEMBER), (baseUrl) => request(baseUrl)
        .patch(bundleUrl).query(query).send({ mode: "managed", entryFile: "secret.txt" }));

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body).toEqual({ error: EXTERNAL_REFUSAL });
      expect(mockAgentInstructionsService.updateBundle).not.toHaveBeenCalled();
    });

    it("refuses a member pointing managed instructions at an outside folder", async () => {
      mockAgentService.getById.mockResolvedValue(makeAgentWithInstructions("managed", managedInstructionsRoot()));
      const app = await createApp(COMPANY_MEMBER);

      const bundle = await requestApp(app, (baseUrl) => request(baseUrl)
        .patch(bundleUrl).query(query).send({ mode: "external", rootPath: OUTSIDE_ROOT }));
      expect(bundle.status, JSON.stringify(bundle.body)).toBe(403);
      expect(bundle.body).toEqual({ error: EXTERNAL_REFUSAL });
      expect(mockAgentInstructionsService.updateBundle).not.toHaveBeenCalled();

      const instructionsPath = await requestApp(app, (baseUrl) => request(baseUrl)
        .patch(pathUrl).query(query).send({ path: path.join(OUTSIDE_ROOT, "AGENTS.md") }));
      expect(instructionsPath.status, JSON.stringify(instructionsPath.body)).toBe(403);
      expect(instructionsPath.body).toEqual({ error: EXTERNAL_REFUSAL });
      expect(mockAgentService.update).not.toHaveBeenCalled();
    });

    it("refuses a member writing, deleting or re-pointing an outside folder", async () => {
      mockAgentService.getById.mockResolvedValue(makeAgentWithInstructions("external", OUTSIDE_ROOT));
      const app = await createApp(COMPANY_MEMBER);

      const put = await requestApp(app, (baseUrl) => request(baseUrl)
        .put(fileUrl).query(query).send({ path: "AGENTS.md", content: "# Overwritten\n" }));
      expect(put.status, JSON.stringify(put.body)).toBe(403);
      const del = await requestApp(app, (baseUrl) => request(baseUrl)
        .delete(fileUrl).query({ ...query, path: "notes.md" }));
      expect(del.status, JSON.stringify(del.body)).toBe(403);
      const cleared = await requestApp(app, (baseUrl) => request(baseUrl)
        .patch(pathUrl).query(query).send({ path: null }));
      expect(cleared.status, JSON.stringify(cleared.body)).toBe(403);

      for (const res of [put, del, cleared]) expect(res.body).toEqual({ error: EXTERNAL_REFUSAL });
      expect(mockAgentInstructionsService.writeFile).not.toHaveBeenCalled();
      expect(mockAgentInstructionsService.deleteFile).not.toHaveBeenCalled();
      expect(mockAgentService.update).not.toHaveBeenCalled();
    });

    it("lets an instance admin change it", async () => {
      mockAgentService.getById.mockResolvedValue(makeAgentWithInstructions("external", OUTSIDE_ROOT));
      const app = await createApp(INSTANCE_ADMIN);

      const bundle = await requestApp(app, (baseUrl) => request(baseUrl)
        .patch(bundleUrl).query(query).send({ mode: "external", rootPath: OUTSIDE_ROOT }));
      expect(bundle.status, JSON.stringify(bundle.body)).toBe(200);
      const put = await requestApp(app, (baseUrl) => request(baseUrl)
        .put(fileUrl).query(query).send({ path: "AGENTS.md", content: "# Updated Agent\n" }));
      expect(put.status, JSON.stringify(put.body)).toBe(200);
      const del = await requestApp(app, (baseUrl) => request(baseUrl)
        .delete(fileUrl).query({ ...query, path: "notes.md" }));
      expect(del.status, JSON.stringify(del.body)).toBe(200);
    });

    it("keeps the usual rules for a member changing Paperclip's own managed folder", async () => {
      mockAgentService.getById.mockResolvedValue(makeAgentWithInstructions("managed", managedInstructionsRoot()));
      const app = await createApp(COMPANY_MEMBER);

      const bundle = await requestApp(app, (baseUrl) => request(baseUrl)
        .patch(bundleUrl).query(query).send({ mode: "managed" }));
      expect(bundle.status, JSON.stringify(bundle.body)).toBe(200);
      const put = await requestApp(app, (baseUrl) => request(baseUrl)
        .put(fileUrl).query(query).send({ path: "AGENTS.md", content: "# Updated Agent\n" }));
      expect(put.status, JSON.stringify(put.body)).toBe(200);
      const del = await requestApp(app, (baseUrl) => request(baseUrl)
        .delete(fileUrl).query({ ...query, path: "notes.md" }));
      expect(del.status, JSON.stringify(del.body)).toBe(200);
    });
  });

  describe("instruction file paths that leave the agent's folder", () => {
    // Another drive, an absolute path on this one, a network share and a
    // device path. A path on another drive used to be read, written and
    // deleted there.
    const ESCAPING_PATHS = [
      "E:/paperclip-instructions-escape-check.md",
      "C:\\Windows\\win.ini",
      "\\\\server\\share\\secret.md",
      "\\\\?\\C:\\Windows\\win.ini",
    ];
    const query = { companyId: "company-1" };
    const fileUrl = `/api/agents/${AGENT_ID}/instructions-bundle/file`;
    let paperclipHome = "";

    beforeEach(async () => {
      paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-instruction-paths-"));
      process.env.PAPERCLIP_HOME = paperclipHome;
      // The real service behind the mocked one, on a real managed folder.
      const actual = await vi.importActual<typeof import("../services/agent-instructions.js")>(
        "../services/agent-instructions.js",
      );
      const real = actual.agentInstructionsService();
      mockAgentInstructionsService.readFile.mockImplementation(real.readFile);
      mockAgentInstructionsService.writeFile.mockImplementation(real.writeFile);
      mockAgentInstructionsService.deleteFile.mockImplementation(real.deleteFile);
      const root = managedInstructionsRoot();
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(path.join(root, "AGENTS.md"), "# Agent\n", "utf8");
      mockAgentService.getById.mockResolvedValue(makeAgentWithInstructions("managed", root));
      mockAccessService.canUser.mockResolvedValue(true);
    });

    afterEach(async () => {
      await fs.rm(paperclipHome, { recursive: true, force: true });
    });

    it.each(ESCAPING_PATHS)("refuses an agent and a member reading %s", async (filePath) => {
      for (const actor of [SAME_AGENT, COMPANY_MEMBER]) {
        const res = await requestApp(await createApp(actor), (baseUrl) => request(baseUrl)
          .get(fileUrl).query({ ...query, path: filePath }));
        expect(res.status, JSON.stringify(res.body)).toBe(422);
        expect(res.body.error).toBe(PATH_REFUSAL);
      }
    });

    it.each(ESCAPING_PATHS)("refuses a member writing %s", async (filePath) => {
      const res = await requestApp(await createApp(COMPANY_MEMBER), (baseUrl) => request(baseUrl)
        .put(fileUrl).query(query).send({ path: filePath, content: "# Overwritten\n" }));
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.error).toBe(PATH_REFUSAL);
    });

    it.each(ESCAPING_PATHS)("refuses a member deleting %s", async (filePath) => {
      const res = await requestApp(await createApp(COMPANY_MEMBER), (baseUrl) => request(baseUrl)
        .delete(fileUrl).query({ ...query, path: filePath }));
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.error).toBe(PATH_REFUSAL);
    });

    it.each(ESCAPING_PATHS)("refuses an agent writing or deleting %s", async (filePath) => {
      const app = await createApp(SAME_AGENT);
      const put = await requestApp(app, (baseUrl) => request(baseUrl)
        .put(fileUrl).query(query).send({ path: filePath, content: "# Overwritten\n" }));
      expect(put.status, JSON.stringify(put.body)).toBe(403);
      const del = await requestApp(app, (baseUrl) => request(baseUrl)
        .delete(fileUrl).query({ ...query, path: filePath }));
      expect(del.status, JSON.stringify(del.body)).toBe(403);
      expect(mockAgentInstructionsService.writeFile).not.toHaveBeenCalled();
      expect(mockAgentInstructionsService.deleteFile).not.toHaveBeenCalled();
    });

    it("still writes, reads and deletes a file inside the folder, backslashes and all", async () => {
      const app = await createApp(COMPANY_MEMBER);

      const put = await requestApp(app, (baseUrl) => request(baseUrl)
        .put(fileUrl).query(query).send({ path: "docs\\notes.md", content: "# Notes\n" }));
      expect(put.status, JSON.stringify(put.body)).toBe(200);
      expect(put.body).toMatchObject({ path: "docs/notes.md", content: "# Notes\n" });

      const get = await requestApp(app, (baseUrl) => request(baseUrl)
        .get(fileUrl).query({ ...query, path: "docs/notes.md" }));
      expect(get.status, JSON.stringify(get.body)).toBe(200);
      expect(get.body).toMatchObject({ content: "# Notes\n" });

      const del = await requestApp(app, (baseUrl) => request(baseUrl)
        .delete(fileUrl).query({ ...query, path: "docs\\notes.md" }));
      expect(del.status, JSON.stringify(del.body)).toBe(200);
      await expect(fs.stat(path.join(managedInstructionsRoot(), "docs", "notes.md"))).rejects.toThrow();
    });
  });
});
