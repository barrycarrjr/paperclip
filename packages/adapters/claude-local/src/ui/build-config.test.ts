import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildClaudeLocalConfig } from "./build-config.js";

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "claude_local",
    cwd: "",
    promptTemplate: "",
    model: "",
    thinkingEffort: "",
    chrome: false,
    search: false,
    fastMode: false,
    command: "",
    args: "",
    extraArgs: "",
    envVars: "",
    envBindings: {},
    url: "",
    bootstrapPrompt: "",
    maxTurnsPerRun: 1000,
    heartbeatEnabled: false,
    intervalSec: 300,
    ...overrides,
  };
}

describe("buildClaudeLocalConfig run permissions", () => {
  it("leaves dangerouslySkipPermissions unset when none was chosen, so the agent inherits the default", () => {
    expect(buildClaudeLocalConfig(makeValues())).not.toHaveProperty("dangerouslySkipPermissions");
  });

  it("keeps an explicit choice", () => {
    expect(buildClaudeLocalConfig(makeValues({ dangerouslySkipPermissions: false })).dangerouslySkipPermissions).toBe(false);
    expect(buildClaudeLocalConfig(makeValues({ dangerouslySkipPermissions: true })).dangerouslySkipPermissions).toBe(true);
  });
});
