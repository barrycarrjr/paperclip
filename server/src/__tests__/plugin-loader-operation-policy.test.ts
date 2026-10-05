/**
 * Verification that plugin-loader persists and reloads per-operation approval policies,
 * and registers operations-only plugins upon load/reload.
 *
 * @see Issue #22
 * @see PLUGIN_SPEC.md §11.8 — Operator control over operations
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1, PluginOperationPolicy, PluginRecord } from "@paperclipai/shared";
import { pluginLoader } from "../services/plugin-loader.js";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  getConfig: vi.fn(),
  upsertConfig: vi.fn(),
  setOperationPolicy: vi.fn(),
  listByStatus: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
  };
});

vi.mock("../middleware/logger.js", () => {
  const child = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return { logger: { ...child, child: () => child }, httpLogger: vi.fn() };
});

const pluginId = "11111111-1111-4111-8111-111111111111";

function manifestWithBoth(): PaperclipPluginManifestV1 {
  return {
    id: "acme.both-tools-and-ops",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Both Tools and Ops",
    description: "Plugin declaring both tools and operations",
    author: "Acme",
    categories: ["automation"],
    capabilities: ["agent.tools.register", "ui.action.register"],
    entrypoints: { worker: "./dist/worker.js" },
    tools: [
      {
        name: "echo-tool",
        displayName: "Echo Tool",
        description: "Echoes input",
        parametersSchema: { type: "object" },
      },
    ],
    operations: [
      {
        key: "send-invoice",
        displayName: "Send invoice",
        description: "Email an invoice.",
        parametersSchema: { type: "object" },
        writes: true,
      },
    ],
  };
}

function manifestOpsOnly(): PaperclipPluginManifestV1 {
  return {
    id: "acme.ops-only",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Ops Only",
    description: "Plugin declaring operations only",
    author: "Acme",
    categories: ["automation"],
    capabilities: ["agent.tools.register", "ui.action.register"],
    entrypoints: { worker: "./dist/worker.js" },
    operations: [
      {
        key: "charge-card",
        displayName: "Charge Credit Card",
        description: "Charge a customer card.",
        parametersSchema: { type: "object" },
        writes: true,
      },
    ],
  };
}

describe("plugin-loader per-operation policy persistence and reload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes operationPolicyJson to registerPluginTools when activating a plugin with both tools and operations", async () => {
    const policy: PluginOperationPolicy = {
      "send-invoice": { requiresApproval: true },
    };
    const pluginRecord: PluginRecord = {
      id: pluginId,
      pluginKey: "acme.both-tools-and-ops",
      packageName: "paperclip-plugin-both",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      status: "ready",
      installOrder: 1,
      packagePath: "/path/to/plugin",
      localSourcePath: null,
      manifestJson: manifestWithBoth(),
      operationPolicyJson: policy,
    };

    mockRegistry.getById.mockResolvedValue(pluginRecord);
    mockRegistry.getConfig.mockResolvedValue(null);

    const registerPluginTools = vi.fn();
    const runtimeServices = {
      workerManager: { startWorker: vi.fn(), stopWorker: vi.fn(), isRunning: vi.fn().mockReturnValue(false) },
      eventBus: { forPlugin: vi.fn().mockReturnValue({}), subscriptionCount: vi.fn().mockReturnValue(0), clearPlugin: vi.fn() },
      jobScheduler: { registerPlugin: vi.fn(), unregisterPlugin: vi.fn() },
      jobStore: { syncJobDeclarations: vi.fn() },
      toolDispatcher: { registerPluginTools, unregisterPluginTools: vi.fn(), toolCount: vi.fn().mockReturnValue(2) },
      lifecycleManager: {} as never,
      buildHostHandlers: vi.fn().mockReturnValue({}),
      instanceInfo: { instanceId: "inst-1", hostVersion: "1.0.0" },
    };

    const loader = pluginLoader({} as never, { enableLocalFilesystem: false, enableNpmDiscovery: false }, runtimeServices as never);
    const result = await loader.loadSingle(pluginId);

    expect(result.success).toBe(true);
    expect(registerPluginTools).toHaveBeenCalledTimes(1);
    expect(registerPluginTools).toHaveBeenCalledWith(
      "acme.both-tools-and-ops",
      pluginRecord.manifestJson,
      pluginId,
      policy,
    );
  });

  it("registers operations and passes operationPolicyJson for operations-only plugins", async () => {
    const policy: PluginOperationPolicy = {
      "charge-card": { requiresApproval: true },
    };
    const pluginRecord: PluginRecord = {
      id: pluginId,
      pluginKey: "acme.ops-only",
      packageName: "paperclip-plugin-ops-only",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      status: "ready",
      installOrder: 1,
      packagePath: "/path/to/plugin",
      localSourcePath: null,
      manifestJson: manifestOpsOnly(),
      operationPolicyJson: policy,
    };

    mockRegistry.getById.mockResolvedValue(pluginRecord);
    mockRegistry.getConfig.mockResolvedValue(null);

    const registerPluginTools = vi.fn();
    const runtimeServices = {
      workerManager: { startWorker: vi.fn(), stopWorker: vi.fn(), isRunning: vi.fn().mockReturnValue(false) },
      eventBus: { forPlugin: vi.fn().mockReturnValue({}), subscriptionCount: vi.fn().mockReturnValue(0), clearPlugin: vi.fn() },
      jobScheduler: { registerPlugin: vi.fn(), unregisterPlugin: vi.fn() },
      jobStore: { syncJobDeclarations: vi.fn() },
      toolDispatcher: { registerPluginTools, unregisterPluginTools: vi.fn(), toolCount: vi.fn().mockReturnValue(1) },
      lifecycleManager: {} as never,
      buildHostHandlers: vi.fn().mockReturnValue({}),
      instanceInfo: { instanceId: "inst-1", hostVersion: "1.0.0" },
    };

    const loader = pluginLoader({} as never, { enableLocalFilesystem: false, enableNpmDiscovery: false }, runtimeServices as never);
    const result = await loader.loadSingle(pluginId);

    expect(result.success).toBe(true);
    expect(registerPluginTools).toHaveBeenCalledTimes(1);
    expect(registerPluginTools).toHaveBeenCalledWith(
      "acme.ops-only",
      pluginRecord.manifestJson,
      pluginId,
      policy,
    );
  });

  it("retains operation approval policy across loadAll at server startup", async () => {
    const policy: PluginOperationPolicy = {
      "send-invoice": { requiresApproval: true },
    };
    const pluginRecord: PluginRecord = {
      id: pluginId,
      pluginKey: "acme.both-tools-and-ops",
      packageName: "paperclip-plugin-both",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      status: "ready",
      installOrder: 1,
      packagePath: "/path/to/plugin",
      localSourcePath: null,
      manifestJson: manifestWithBoth(),
      operationPolicyJson: policy,
    };

    mockRegistry.listByStatus.mockResolvedValue([pluginRecord]);
    mockRegistry.getConfig.mockResolvedValue(null);

    const registerPluginTools = vi.fn();
    const runtimeServices = {
      workerManager: { startWorker: vi.fn(), stopWorker: vi.fn(), isRunning: vi.fn().mockReturnValue(false) },
      eventBus: { forPlugin: vi.fn().mockReturnValue({}), subscriptionCount: vi.fn().mockReturnValue(0), clearPlugin: vi.fn() },
      jobScheduler: { registerPlugin: vi.fn(), unregisterPlugin: vi.fn() },
      jobStore: { syncJobDeclarations: vi.fn() },
      toolDispatcher: { registerPluginTools, unregisterPluginTools: vi.fn(), toolCount: vi.fn().mockReturnValue(2) },
      lifecycleManager: {} as never,
      buildHostHandlers: vi.fn().mockReturnValue({}),
      instanceInfo: { instanceId: "inst-1", hostVersion: "1.0.0" },
    };

    const loader = pluginLoader({} as never, { enableLocalFilesystem: false, enableNpmDiscovery: false }, runtimeServices as never);
    const result = await loader.loadAll();

    expect(result.succeeded).toBe(1);
    expect(registerPluginTools).toHaveBeenCalledWith(
      "acme.both-tools-and-ops",
      pluginRecord.manifestJson,
      pluginId,
      policy,
    );
  });
});
