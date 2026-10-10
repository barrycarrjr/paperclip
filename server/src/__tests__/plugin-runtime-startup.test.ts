import { describe, expect, it } from "vitest";
import { PLUGIN_RUNTIME_ENV, pluginRuntimeEnabledFromEnv, startPluginRuntime } from "../plugin-runtime-startup.js";

function recorder() {
  const calls: string[] = [];
  return {
    calls,
    steps: {
      startJobCoordinator: () => calls.push("coordinator"),
      startScheduler: () => calls.push("scheduler"),
      loadPlugins: () => calls.push("load"),
      warmExternalMcpServers: () => calls.push("warm"),
      onSkipped: () => calls.push("skipped"),
    },
  };
}

describe("plugin runtime start-up", () => {
  it("is on unless the variable is exactly false", () => {
    expect(PLUGIN_RUNTIME_ENV).toBe("PAPERCLIP_PLUGIN_RUNTIME_ENABLED");
    expect(pluginRuntimeEnabledFromEnv({})).toBe(true);
    expect(pluginRuntimeEnabledFromEnv({ PAPERCLIP_PLUGIN_RUNTIME_ENABLED: "true" })).toBe(true);
    expect(pluginRuntimeEnabledFromEnv({ PAPERCLIP_PLUGIN_RUNTIME_ENABLED: "0" })).toBe(true);
    expect(pluginRuntimeEnabledFromEnv({ PAPERCLIP_PLUGIN_RUNTIME_ENABLED: "false" })).toBe(false);
  });

  it("starts the coordinator, the scheduler, the plugins and the external MCP warm-up when enabled", () => {
    const { calls, steps } = recorder();
    expect(startPluginRuntime(true, steps)).toBe(true);
    expect(calls).toEqual(["coordinator", "scheduler", "load", "warm"]);
  });

  it("starts none of them when disabled, as on an update's trial start", () => {
    const { calls, steps } = recorder();
    expect(startPluginRuntime(false, steps)).toBe(false);
    expect(calls).toEqual(["skipped"]);
  });
});
