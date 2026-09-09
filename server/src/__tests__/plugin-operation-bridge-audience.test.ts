/**
 * The UI lane must honour an operation's declared audience.
 *
 * An operation declared `audience: "agents"` is machine-shaped work the plugin
 * author does not want anyone firing from a screen. The host enforces that at
 * the bridge routes rather than trusting the plugin's own UI not to render the
 * button, because the UI runs same-origin in the browser and is not a
 * boundary.
 *
 * @see PLUGIN_SPEC.md §11.5 — Operations
 */

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  upsertConfig: vi.fn(),
}));

const mockLifecycle = vi.hoisted(() => ({
  load: vi.fn(),
  upgrade: vi.fn(),
  unload: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => mockLifecycle,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

vi.mock("../services/live-events.js", () => ({
  publishGlobalLiveEvent: vi.fn(),
}));

vi.mock("../middleware/logger.js", () => {
  const child = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return {
    logger: { ...child, child: () => child },
    httpLogger: vi.fn(),
  };
});

const companyA = "22222222-2222-4222-8222-222222222222";
const pluginId = "11111111-1111-4111-8111-111111111111";

function manifest(operations: PaperclipPluginManifestV1["operations"]): PaperclipPluginManifestV1 {
  return {
    id: "paperclip.example",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Example",
    description: "Example plugin",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: ["agent.tools.register", "ui.action.register"],
    entrypoints: { worker: "./dist/worker.js" },
    operations,
  };
}

function readyPlugin(operations: PaperclipPluginManifestV1["operations"]) {
  mockRegistry.getById.mockResolvedValue({
    id: pluginId,
    pluginKey: "paperclip.example",
    version: "1.0.0",
    status: "ready",
    manifestJson: manifest(operations),
  });
}

async function createApp(call: ReturnType<typeof vi.fn>) {
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
      isInstanceAdmin: false,
      companyIds: [companyA],
    } as typeof req.actor;
    next();
  });
  app.use("/api", pluginRoutes(
    {} as never,
    { installPlugin: vi.fn() } as never,
    undefined as never,
    undefined,
    undefined as never,
    { workerManager: { call } } as never,
  ));
  app.use(errorHandler);

  return app;
}

const operationDecl = {
  key: "reindex",
  displayName: "Reindex",
  description: "Rebuild the search index.",
  parametersSchema: { type: "object" as const },
};

const bothActionRoutes = [
  ["url-keyed", `/api/plugins/${pluginId}/actions/reindex`, {}],
  ["body-keyed", `/api/plugins/${pluginId}/bridge/action`, { key: "reindex" }],
] as const;

describe.sequential("plugin operation audience on the UI bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(bothActionRoutes)(
    "refuses an agent-only operation on the %s action route",
    async (_name, path, body) => {
      readyPlugin([{ ...operationDecl, audience: "agents" }]);
      const call = vi.fn().mockResolvedValue({ ok: true });
      const app = await createApp(call);

      const res = await request(app)
        .post(path)
        .send({ ...body, companyId: companyA });

      expect(res.status).toBe(403);
      // Refused before the worker is touched — the point is that the side
      // effect never runs, not that it runs and is then reported.
      expect(call).not.toHaveBeenCalled();
    },
  );

  it.each(bothActionRoutes)(
    "allows a both-audience operation on the %s action route",
    async (_name, path, body) => {
      readyPlugin([{ ...operationDecl, audience: "both" }]);
      const call = vi.fn().mockResolvedValue({ ok: true });
      const app = await createApp(call);

      const res = await request(app)
        .post(path)
        .send({ ...body, companyId: companyA });

      expect(res.status).toBe(200);
      expect(call).toHaveBeenCalledTimes(1);
    },
  );

  it("allows a user-only operation from the UI", async () => {
    readyPlugin([{ ...operationDecl, audience: "users" }]);
    const call = vi.fn().mockResolvedValue({ ok: true });
    const app = await createApp(call);

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/actions/reindex`)
      .send({ companyId: companyA });

    expect(res.status).toBe(200);
  });

  it("treats a missing audience as both", async () => {
    readyPlugin([operationDecl]);
    const call = vi.fn().mockResolvedValue({ ok: true });
    const app = await createApp(call);

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/actions/reindex`)
      .send({ companyId: companyA });

    expect(res.status).toBe(200);
  });

  it("leaves a plain action key alone", async () => {
    // Not a declared operation at all — the older `ctx.actions.register` style
    // still works and is not subject to audience rules.
    readyPlugin([{ ...operationDecl, audience: "agents" }]);
    const call = vi.fn().mockResolvedValue({ ok: true });
    const app = await createApp(call);

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/actions/some-legacy-action`)
      .send({ companyId: companyA });

    expect(res.status).toBe(200);
    expect(call).toHaveBeenCalledTimes(1);
  });
});
