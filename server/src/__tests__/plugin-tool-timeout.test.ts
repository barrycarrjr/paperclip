import { describe, expect, it, vi } from "vitest";
import { pluginToolDeclarationSchema, type PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createPluginToolRegistry } from "../services/plugin-tool-registry.js";

describe("declared plugin tool timeouts", () => {
  it("validates a bounded duration and leaves ordinary tools at the host default", () => {
    const tool = { name: "diagnose", displayName: "Diagnose", description: "Check", parametersSchema: { type: "object" } };
    expect(pluginToolDeclarationSchema.parse({ ...tool, executionTimeoutMs: 210_000 }).executionTimeoutMs).toBe(210_000);
    for (const timeout of [0, 500, 300_001, 1.5, Infinity]) expect(pluginToolDeclarationSchema.safeParse({ ...tool, executionTimeoutMs: timeout }).success).toBe(false);
    expect(pluginToolDeclarationSchema.parse(tool).executionTimeoutMs).toBeUndefined();
  });
  it("uses only manifest timing, ignores caller timing, and clamps hand-edited declarations", async () => {
    const call = vi.fn().mockResolvedValue({ data: { ok: true } });
    const registry = createPluginToolRegistry({ isRunning: () => true, call } as never);
    registry.registerPlugin("example", { id: "example", tools: [
      { name: "long", executionTimeoutMs: 210_000 }, { name: "ordinary" }, { name: "invalid", executionTimeoutMs: 900_000 },
    ] } as PaperclipPluginManifestV1);
    const run = { companyId: "company", agentId: "agent", runId: "run" };
    await registry.executeTool("example:long", { executionTimeoutMs: 999_999 }, run);
    expect(call.mock.calls[0][3]).toBe(210_000);
    await registry.executeTool("example:ordinary", { executionTimeoutMs: 999_999 }, run);
    expect(call.mock.calls[1][3]).toBeUndefined();
    await registry.executeTool("example:invalid", {}, run);
    expect(call.mock.calls[2][3]).toBe(300_000);
  });
});
