/**
 * The operator-facing side of operation policy: reading what an install has
 * settled on, and changing it.
 *
 * Two things are worth pinning here beyond the happy path. A widening override
 * is refused at the door rather than stored and quietly ignored, because a
 * setting that looks saved and does nothing is the worst outcome for a
 * security control. And a saved change re-registers the plugin's tools
 * immediately, so an agent mid-run sees the new answer on its next call rather
 * than at the next restart.
 *
 * @see PLUGIN_SPEC.md §11.8 — Operator control over operations
 */

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  upsertConfig: vi.fn(),
  setOperationPolicy: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => ({
    load: vi.fn(), upgrade: vi.fn(), unload: vi.fn(), enable: vi.fn(), disable: vi.fn(),
  }),
}));

vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));
vi.mock("../services/live-events.js", () => ({ publishGlobalLiveEvent: vi.fn() }));

vi.mock("../middleware/logger.js", () => {
  const child = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return { logger: { ...child, child: () => child }, httpLogger: vi.fn() };
});

const pluginId = "11111111-1111-4111-8111-111111111111";

const operations: PaperclipPluginManifestV1["operations"] = [
  {
    key: "send-invoice",
    displayName: "Send invoice",
    description: "Email an invoice.",
    parametersSchema: { type: "object" },
    writes: true,
  },
  {
    key: "pick-file",
    displayName: "Pick a file",
    description: "Open a file picker.",
    parametersSchema: { type: "object" },
    audience: "users",
  },
];

function manifest(): PaperclipPluginManifestV1 {
  return {
    id: "acme.ops",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Ops",
    description: "Operations",
    author: "Acme",
    categories: ["automation"],
    capabilities: ["agent.tools.register", "ui.action.register"],
    entrypoints: { worker: "./dist/worker.js" },
    operations,
  };
}

function installedPlugin(policy: Record<string, unknown> = {}) {
  mockRegistry.getById.mockResolvedValue({
    id: pluginId,
    pluginKey: "acme.ops",
    version: "1.0.0",
    status: "ready",
    manifestJson: manifest(),
    operationPolicyJson: policy,
  });
}

async function createApp(opts: { admin: boolean; registerPluginTools?: ReturnType<typeof vi.fn> }) {
  const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"),
    import("../middleware/index.js"),
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: opts.admin,
      companyIds: [],
    } as typeof req.actor;
    next();
  });
  app.use("/api", pluginRoutes(
    {} as never,
    { installPlugin: vi.fn() } as never,
    undefined as never,
    undefined,
    { toolDispatcher: { registerPluginTools: opts.registerPluginTools ?? vi.fn() } } as never,
    { workerManager: { call: vi.fn() } } as never,
  ));
  app.use(errorHandler);
  return app;
}

describe.sequential("plugin operation policy routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegistry.setOperationPolicy.mockImplementation(async (_id, policy) => ({
      operationPolicyJson: policy,
    }));
  });

  it("lists operations with what the author declared and what this install settled on", async () => {
    installedPlugin({ "send-invoice": { requiresApproval: true } });
    const app = await createApp({ admin: true });

    const res = await request(app).get(`/api/plugins/${pluginId}/operations`);

    expect(res.status).toBe(200);
    const invoice = res.body.operations.find((o: { key: string }) => o.key === "send-invoice");
    // Both are shown so an operator can see when their override does nothing.
    expect(invoice.declaredAudience).toBe("both");
    expect(invoice.effective).toMatchObject({ audience: "both", requiresApproval: true });
    expect(invoice.writes).toBe(true);
  });

  it("keeps the list to instance admins", async () => {
    installedPlugin();
    const app = await createApp({ admin: false });

    // "May an agent send email on our behalf" is not a per-company decision.
    const res = await request(app).get(`/api/plugins/${pluginId}/operations`);

    expect(res.status).toBe(403);
  });

  it("saves a narrowing override and re-registers so it takes effect at once", async () => {
    installedPlugin();
    const registerPluginTools = vi.fn();
    const app = await createApp({ admin: true, registerPluginTools });

    const res = await request(app)
      .put(`/api/plugins/${pluginId}/operations/policy`)
      .send({ policy: { "send-invoice": { audience: "users", requiresApproval: true } } });

    expect(res.status).toBe(200);
    expect(mockRegistry.setOperationPolicy).toHaveBeenCalledWith(pluginId, {
      "send-invoice": { audience: "users", requiresApproval: true },
    });
    // Without this an agent mid-run keeps the old answer until a restart.
    expect(registerPluginTools).toHaveBeenCalledTimes(1);
  });

  it("refuses an override that would widen what the plugin publishes", async () => {
    installedPlugin();
    const registerPluginTools = vi.fn();
    const app = await createApp({ admin: true, registerPluginTools });

    // `pick-file` is declared users-only. Config must not be able to hand it
    // to agents.
    const res = await request(app)
      .put(`/api/plugins/${pluginId}/operations/policy`)
      .send({ policy: { "pick-file": { audience: "both" } } });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("can only narrow");
    expect(mockRegistry.setOperationPolicy).not.toHaveBeenCalled();
    expect(registerPluginTools).not.toHaveBeenCalled();
  });

  it("refuses an override naming an operation the plugin does not have", async () => {
    installedPlugin();
    const app = await createApp({ admin: true });

    // A typo would otherwise look like a saved setting that silently does
    // nothing.
    const res = await request(app)
      .put(`/api/plugins/${pluginId}/operations/policy`)
      .send({ policy: { "send-invoce": { disabled: true } } });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("no operation named");
  });

  it("refuses a misspelled control", async () => {
    installedPlugin();
    const app = await createApp({ admin: true });

    const res = await request(app)
      .put(`/api/plugins/${pluginId}/operations/policy`)
      .send({ policy: { "send-invoice": { requireApproval: true } } });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid operation policy");
  });

  it("replaces the whole map rather than merging into it", async () => {
    installedPlugin({ "send-invoice": { disabled: true }, "pick-file": { disabled: true } });
    const app = await createApp({ admin: true });

    const res = await request(app)
      .put(`/api/plugins/${pluginId}/operations/policy`)
      .send({ policy: { "send-invoice": { requiresApproval: true } } });

    expect(res.status).toBe(200);
    // A merge would make "clear this override" the one thing the settings
    // screen could not express.
    expect(mockRegistry.setOperationPolicy).toHaveBeenCalledWith(pluginId, {
      "send-invoice": { requiresApproval: true },
    });
  });

  it("accepts an empty map as clearing every override", async () => {
    installedPlugin({ "send-invoice": { disabled: true } });
    const app = await createApp({ admin: true });

    const res = await request(app)
      .put(`/api/plugins/${pluginId}/operations/policy`)
      .send({ policy: {} });

    expect(res.status).toBe(200);
    expect(mockRegistry.setOperationPolicy).toHaveBeenCalledWith(pluginId, {});
  });

  it("keeps changes to instance admins", async () => {
    installedPlugin();
    const app = await createApp({ admin: false });

    const res = await request(app)
      .put(`/api/plugins/${pluginId}/operations/policy`)
      .send({ policy: { "send-invoice": { disabled: true } } });

    expect(res.status).toBe(403);
    expect(mockRegistry.setOperationPolicy).not.toHaveBeenCalled();
  });

  it("refuses a UI call to an operation the operator switched off", async () => {
    installedPlugin({ "send-invoice": { disabled: true } });
    const app = await createApp({ admin: true });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/actions/send-invoice`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("switched off");
  });

  it("refuses a UI call to an operation the operator narrowed to agents", async () => {
    installedPlugin({ "send-invoice": { audience: "agents" } });
    const app = await createApp({ admin: true });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/actions/send-invoice`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("not available from the UI");
  });
});
