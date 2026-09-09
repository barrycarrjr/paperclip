/**
 * Operations — one declaration, both lanes.
 *
 * A plugin used to say the same thing twice: a `tools[]` entry plus a
 * `ctx.tools.register` handler for agents, and a separate, undeclared
 * `ctx.actions.register` key for its own screen. Nothing checked the two
 * agreed, so they drifted.
 *
 * These tests pin the replacement: a single `ctx.operations.register` handler
 * that both `executeTool` (agents) and `performAction` (people) resolve to,
 * and a host registry that publishes it to agents only when the declared
 * audience allows.
 *
 * @see PLUGIN_SPEC.md §11.5 — Operations
 */

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createTestHarness } from "../../../packages/plugins/sdk/src/testing.js";
import { definePlugin } from "../../../packages/plugins/sdk/src/define-plugin.js";
import { startWorkerRpcHost } from "../../../packages/plugins/sdk/src/worker-rpc-host.js";
import {
  createRequest,
  isJsonRpcErrorResponse,
  isJsonRpcSuccessResponse,
  parseMessage,
  serializeMessage,
} from "../../../packages/plugins/sdk/src/protocol.js";
import type { PluginOperationContext } from "../../../packages/plugins/sdk/src/types.js";
import { createPluginToolRegistry } from "../services/plugin-tool-registry.js";

/** Newline the worker uses to delimit JSON-RPC messages on stdout. */
const LINE_BREAK = String.fromCharCode(10);

function manifest(overrides: Partial<PaperclipPluginManifestV1> = {}): PaperclipPluginManifestV1 {
  return {
    id: "paperclip.test-operations",
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Test Operations",
    description: "Test plugin",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: ["agent.tools.register", "ui.action.register"],
    entrypoints: { worker: "./dist/worker.js" },
    ...overrides,
  };
}

function operation(overrides: Record<string, unknown> = {}) {
  return {
    key: "build-report",
    displayName: "Build report",
    description: "Build the weekly report.",
    parametersSchema: { type: "object", properties: { week: { type: "string" } } },
    ...overrides,
  };
}

describe("plugin operations — worker lane resolution", () => {
  it("routes both an agent call and a UI click to the same handler", async () => {
    const seen: PluginOperationContext[] = [];
    const harness = createTestHarness({ manifest: manifest({ operations: [operation()] }) });

    harness.ctx.operations.register("build-report", async (params, opCtx) => {
      seen.push(opCtx);
      const { week } = params as { week?: string };
      return { content: `built ${week}`, data: { week } };
    });

    const fromAgent = await harness.executeTool("build-report", { week: "w1" }, {
      agentId: "agent-7",
      runId: "run-7",
      companyId: "co-1",
    });
    const fromUser = await harness.performAction("build-report", {
      week: "w2",
      hostScope: { companyId: "co-1", userId: "user-3" },
    });

    // One registration served two callers, and each was told which it was.
    expect(seen).toHaveLength(2);
    expect(seen[0]?.invokedBy).toBe("agent");
    expect(seen[1]?.invokedBy).toBe("user");
    expect(fromAgent).toEqual({ content: "built w1", data: { week: "w1" } });
    expect(fromUser).toEqual({ content: "built w2", data: { week: "w2" } });
  });

  it("gives the agent lane the run identifiers and the UI lane the person", async () => {
    const seen: PluginOperationContext[] = [];
    const harness = createTestHarness({ manifest: manifest({ operations: [operation()] }) });

    harness.ctx.operations.register("build-report", async (_params, opCtx) => {
      seen.push(opCtx);
      return { content: "ok" };
    });

    await harness.executeTool("build-report", {}, {
      agentId: "agent-7",
      runId: "run-7",
      companyId: "co-1",
      projectId: "proj-1",
    });
    await harness.performAction("build-report", {
      hostScope: { companyId: "co-9", userId: "user-3" },
    });

    expect(seen[0]).toMatchObject({
      invokedBy: "agent",
      agentId: "agent-7",
      runId: "run-7",
      companyId: "co-1",
      projectId: "proj-1",
    });

    // A button click has a person and no run. Reporting a fabricated agentId
    // here would let a plugin file the click as agent activity.
    expect(seen[1]).toMatchObject({
      invokedBy: "user",
      companyId: "co-9",
      userId: "user-3",
    });
    expect(seen[1]?.agentId).toBeUndefined();
    expect(seen[1]?.runId).toBeUndefined();
  });

  it("takes the UI-lane company from the host-stamped scope, not from caller params", async () => {
    let seenCompany: string | undefined;
    const harness = createTestHarness({ manifest: manifest({ operations: [operation()] }) });

    harness.ctx.operations.register("build-report", async (_params, opCtx) => {
      seenCompany = opCtx.companyId;
      return { content: "ok" };
    });

    // `companyId` sitting loose in params is browser-supplied. `hostScope` is
    // the one the host validated, so it must win.
    await harness.performAction("build-report", {
      companyId: "co-attacker",
      hostScope: { companyId: "co-real", userId: "user-3" },
    });

    expect(seenCompany).toBe("co-real");
  });

  it("still serves a plain action key, so existing plugins keep working", async () => {
    const harness = createTestHarness({ manifest: manifest() });

    harness.ctx.actions.register("legacy-resync", async () => ({ ok: true }));

    await expect(harness.performAction("legacy-resync")).resolves.toEqual({ ok: true });
  });

  it("names both lanes when a key is registered on neither", async () => {
    const harness = createTestHarness({ manifest: manifest() });

    await expect(harness.performAction("nope")).rejects.toThrow(
      /No action or operation handler registered/,
    );
    await expect(harness.executeTool("nope", {})).rejects.toThrow(
      /No tool or operation handler registered/,
    );
  });

  it("refuses to register an operation without the capability its audience needs", async () => {
    const agentOnlyCaps = createTestHarness({
      manifest: manifest({
        capabilities: ["agent.tools.register"],
        operations: [operation({ audience: "both" })],
      }),
    });

    expect(() => {
      agentOnlyCaps.ctx.operations.register("build-report", async () => ({ content: "ok" }));
    }).toThrow(/ui\.action\.register/);

    const uiOnlyCaps = createTestHarness({
      manifest: manifest({
        capabilities: ["ui.action.register"],
        operations: [operation({ audience: "both" })],
      }),
    });

    expect(() => {
      uiOnlyCaps.ctx.operations.register("build-report", async () => ({ content: "ok" }));
    }).toThrow(/agent\.tools\.register/);
  });
});

describe("plugin operations — host registry publishing", () => {
  it("publishes an operation to agents under the plugin namespace", () => {
    const registry = createPluginToolRegistry();
    registry.registerPlugin("acme.reporting", manifest({ operations: [operation()] }));

    const tool = registry.getTool("acme.reporting:build-report");
    expect(tool).not.toBeNull();
    expect(tool?.isOperation).toBe(true);
    expect(tool?.audience).toBe("both");
    expect(tool?.description).toBe("Build the weekly report.");
  });

  it("publishes an agent-only operation", () => {
    const registry = createPluginToolRegistry();
    registry.registerPlugin(
      "acme.reporting",
      manifest({ operations: [operation({ audience: "agents" })] }),
    );

    expect(registry.getTool("acme.reporting:build-report")?.audience).toBe("agents");
  });

  it("keeps a user-only operation out of the agent tool list entirely", () => {
    const registry = createPluginToolRegistry();
    registry.registerPlugin(
      "acme.reporting",
      manifest({ operations: [operation({ audience: "users" })] }),
    );

    // Not filtered at list time — never registered, so there is no path by
    // which an agent could reach it.
    expect(registry.getTool("acme.reporting:build-report")).toBeNull();
    expect(registry.toolCount("acme.reporting")).toBe(0);
  });

  it("registers legacy tools and operations side by side", () => {
    const registry = createPluginToolRegistry();
    registry.registerPlugin("acme.reporting", manifest({
      tools: [{
        name: "search-reports",
        displayName: "Search reports",
        description: "Search.",
        parametersSchema: { type: "object" },
      }],
      operations: [operation()],
    }));

    expect(registry.toolCount("acme.reporting")).toBe(2);
    expect(registry.getTool("acme.reporting:search-reports")?.isOperation).toBe(false);
    expect(registry.getTool("acme.reporting:build-report")?.isOperation).toBe(true);
  });

  it("keeps the tool when an operation key collides, rather than letting one silently win", () => {
    const registry = createPluginToolRegistry();
    registry.registerPlugin("acme.reporting", manifest({
      tools: [{
        name: "build-report",
        displayName: "Build report (tool)",
        description: "The legacy declaration.",
        parametersSchema: { type: "object" },
      }],
      operations: [operation({ displayName: "Build report (operation)" })],
    }));

    // The manifest validator rejects this, but a plugin installed from an
    // older build can still reach the registry, so the collision resolves
    // predictably instead of by declaration order.
    expect(registry.toolCount("acme.reporting")).toBe(1);
    expect(registry.getTool("acme.reporting:build-report")?.displayName)
      .toBe("Build report (tool)");
  });

  it("clears operations when the plugin is unregistered", () => {
    const registry = createPluginToolRegistry();
    registry.registerPlugin("acme.reporting", manifest({ operations: [operation()] }));
    registry.unregisterPlugin("acme.reporting");

    expect(registry.getTool("acme.reporting:build-report")).toBeNull();
  });
});

describe("plugin operations — real worker process", () => {
  it("resolves executeTool and performAction to the one registered handler", async () => {
    // The test harness is a second implementation of the same contract, so it
    // can agree with itself while the worker that actually ships disagrees.
    // This drives the real JSON-RPC worker over streams.
    const seen: PluginOperationContext[] = [];
    const plugin = definePlugin({
      async setup(ctx) {
        ctx.operations.register("build-report", async (params, opCtx) => {
          seen.push(opCtx);
          const { week } = params as { week?: string };
          return { content: `built ${week ?? "nothing"}` };
        });
      },
    });

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const host = startWorkerRpcHost({ plugin, stdin, stdout });
    const responses: unknown[] = [];
    stdout.on("data", (chunk) => {
      for (const line of String(chunk).split(LINE_BREAK).filter(Boolean)) {
        responses.push(parseMessage(line));
      }
    });

    stdin.write(serializeMessage(createRequest("initialize", {
      manifest: manifest({ operations: [operation()] }),
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
    }, 1)));
    await waitForResponses(responses, 1);

    stdin.write(serializeMessage(createRequest("executeTool", {
      toolName: "build-report",
      parameters: { week: "w1" },
      runContext: {
        agentId: "agent-7",
        runId: "run-7",
        companyId: "co-1",
        projectId: "proj-1",
      },
    }, 2)));
    await waitForResponses(responses, 2);

    const agentResponse = responses[1];
    expect(isJsonRpcSuccessResponse(agentResponse)).toBe(true);
    if (isJsonRpcSuccessResponse(agentResponse)) {
      expect(agentResponse.result).toMatchObject({ content: "built w1" });
    }

    stdin.write(serializeMessage(createRequest("performAction", {
      key: "build-report",
      params: { week: "w2", hostScope: { companyId: "co-2", userId: "user-3" } },
      renderEnvironment: null,
    }, 3)));
    await waitForResponses(responses, 3);

    const userResponse = responses[2];
    expect(isJsonRpcSuccessResponse(userResponse)).toBe(true);
    if (isJsonRpcSuccessResponse(userResponse)) {
      expect(userResponse.result).toMatchObject({ content: "built w2" });
    }

    expect(seen[0]).toMatchObject({
      invokedBy: "agent",
      agentId: "agent-7",
      runId: "run-7",
      companyId: "co-1",
      projectId: "proj-1",
    });
    expect(seen[1]).toMatchObject({
      invokedBy: "user",
      companyId: "co-2",
      userId: "user-3",
    });

    host.stop();
  });

  it("reports an unknown key against both lanes", async () => {
    const plugin = definePlugin({ async setup() {} });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const host = startWorkerRpcHost({ plugin, stdin, stdout });
    const responses: unknown[] = [];
    stdout.on("data", (chunk) => {
      for (const line of String(chunk).split(LINE_BREAK).filter(Boolean)) {
        responses.push(parseMessage(line));
      }
    });

    stdin.write(serializeMessage(createRequest("initialize", {
      manifest: manifest(),
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
    }, 1)));
    await waitForResponses(responses, 1);

    stdin.write(serializeMessage(createRequest("performAction", {
      key: "missing",
      params: {},
    }, 2)));
    await waitForResponses(responses, 2);

    const response = responses[1];
    expect(isJsonRpcErrorResponse(response)).toBe(true);
    if (isJsonRpcErrorResponse(response)) {
      expect(response.error.message).toContain("No action or operation handler");
    }

    host.stop();
  });
});

async function waitForResponses(responses: unknown[], count: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (responses.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(responses.length).toBeGreaterThanOrEqual(count);
}
