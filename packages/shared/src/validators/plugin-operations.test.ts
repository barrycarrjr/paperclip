import { describe, expect, it } from "vitest";
import { pluginManifestV1Schema } from "./plugin.js";

/**
 * A manifest that passes on its own, so each test changes exactly one thing.
 *
 * Operations are the unified declaration: one entry publishes the same
 * callable to agents (as a namespaced tool) and to people (as a UI action).
 * These tests pin the rules that stop the two lanes drifting apart again.
 *
 * @see PLUGIN_SPEC.md §11.5 — Operations
 */
function manifest(overrides: Record<string, unknown> = {}) {
  return {
    id: "example.reporting",
    apiVersion: 1 as const,
    version: "1.0.0",
    displayName: "Reporting",
    description: "Builds reports.",
    author: "Example",
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
    description: "Build the weekly report for a company.",
    parametersSchema: { type: "object", properties: { week: { type: "string" } } },
    ...overrides,
  };
}

describe("plugin manifest — operations", () => {
  it("accepts an operation with no audience and defaults it to both lanes", () => {
    const result = pluginManifestV1Schema.safeParse(
      manifest({ operations: [operation()] }),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.operations?.[0]?.audience).toBeUndefined();
    }
  });

  it("accepts each declared audience", () => {
    for (const audience of ["both", "agents", "users"] as const) {
      const result = pluginManifestV1Schema.safeParse(
        manifest({ operations: [operation({ audience })] }),
      );
      expect(result.success, `audience ${audience} should parse`).toBe(true);
    }
  });

  it("rejects an unknown audience", () => {
    const result = pluginManifestV1Schema.safeParse(
      manifest({ operations: [operation({ audience: "robots" })] }),
    );

    expect(result.success).toBe(false);
  });

  it("requires agent.tools.register when an operation reaches agents", () => {
    const result = pluginManifestV1Schema.safeParse(
      manifest({
        capabilities: ["ui.action.register"],
        operations: [operation({ audience: "both" })],
      }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("agent.tools.register"))).toBe(true);
    }
  });

  it("requires ui.action.register when an operation reaches users", () => {
    const result = pluginManifestV1Schema.safeParse(
      manifest({
        capabilities: ["agent.tools.register"],
        operations: [operation({ audience: "both" })],
      }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("ui.action.register"))).toBe(true);
    }
  });

  it("does not require the UI capability for an agent-only operation", () => {
    const result = pluginManifestV1Schema.safeParse(
      manifest({
        capabilities: ["agent.tools.register"],
        operations: [operation({ audience: "agents" })],
      }),
    );

    expect(result.success).toBe(true);
  });

  it("does not require the agent capability for a user-only operation", () => {
    const result = pluginManifestV1Schema.safeParse(
      manifest({
        capabilities: ["ui.action.register"],
        operations: [operation({ audience: "users" })],
      }),
    );

    expect(result.success).toBe(true);
  });

  it("rejects duplicate operation keys", () => {
    const result = pluginManifestV1Schema.safeParse(
      manifest({ operations: [operation(), operation()] }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("Duplicate operation keys"))).toBe(true);
    }
  });

  it("rejects an operation key that collides with a legacy tool name", () => {
    const result = pluginManifestV1Schema.safeParse(
      manifest({
        tools: [{
          name: "build-report",
          displayName: "Build report",
          description: "Legacy declaration of the same thing.",
          parametersSchema: { type: "object" },
        }],
        operations: [operation()],
      }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("collide with tool names"))).toBe(true);
    }
  });

  it("allows an operation alongside an unrelated legacy tool", () => {
    const result = pluginManifestV1Schema.safeParse(
      manifest({
        tools: [{
          name: "search-reports",
          displayName: "Search reports",
          description: "A different thing entirely.",
          parametersSchema: { type: "object" },
        }],
        operations: [operation()],
      }),
    );

    expect(result.success).toBe(true);
  });

  it("rejects an operation key that is not usable as a tool name", () => {
    const result = pluginManifestV1Schema.safeParse(
      manifest({ operations: [operation({ key: "build report!" })] }),
    );

    expect(result.success).toBe(false);
  });
});
