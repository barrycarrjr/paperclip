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

describe("buildClaudeLocalConfig optional advisor", () => {
  it.each([undefined, "", "   "])("keeps advice disabled when the field is %s", (advisorModel) => {
    const config = buildClaudeLocalConfig(makeValues({ advisorModel }));
    expect(config).not.toHaveProperty("advisorModel");
  });

  it("saves the selected advisor separately without changing the main model or run limits", () => {
    const config = buildClaudeLocalConfig(makeValues({ model: "light-main-model", advisorModel: "  opus  ", maxTurnsPerRun: 7 }));
    expect(config).toMatchObject({ model: "light-main-model", advisorModel: "opus", maxTurnsPerRun: 7, timeoutSec: 300 });
  });

  it("accepts a full provider model id without turning it into an alias", () => {
    expect(buildClaudeLocalConfig(makeValues({ advisorModel: "provider/model-v2.0" })).advisorModel).toBe("provider/model-v2.0");
  });
});
