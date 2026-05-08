import { describe, expect, it } from "vitest";
import { resolveAgentModelForRun } from "../services/resolve-agent-model.ts";

const NO_DEFAULTS = { defaultModelByAdapterType: {} };

describe("resolveAgentModelForRun", () => {
  it("returns the agent's explicitly configured model when set", () => {
    const resolved = resolveAgentModelForRun({
      adapterType: "claude_local",
      configuredModel: "claude-sonnet-4-6",
      instanceAgentDefaults: {
        defaultModelByAdapterType: { claude_local: "claude-opus-4-7" },
      },
    });
    expect(resolved).toBe("claude-sonnet-4-6");
  });

  it("trims surrounding whitespace from explicit models", () => {
    const resolved = resolveAgentModelForRun({
      adapterType: "claude_local",
      configuredModel: "  claude-opus-4-7  ",
      instanceAgentDefaults: NO_DEFAULTS,
    });
    expect(resolved).toBe("claude-opus-4-7");
  });

  it("falls back to instance default when configured model is empty string", () => {
    const resolved = resolveAgentModelForRun({
      adapterType: "claude_local",
      configuredModel: "",
      instanceAgentDefaults: {
        defaultModelByAdapterType: { claude_local: "claude-opus-4-7" },
      },
    });
    expect(resolved).toBe("claude-opus-4-7");
  });

  it("falls back to instance default when configured model is undefined", () => {
    const resolved = resolveAgentModelForRun({
      adapterType: "codex_local",
      configuredModel: undefined,
      instanceAgentDefaults: {
        defaultModelByAdapterType: { codex_local: "gpt-5" },
      },
    });
    expect(resolved).toBe("gpt-5");
  });

  it("falls back to instance default when configured model is whitespace", () => {
    const resolved = resolveAgentModelForRun({
      adapterType: "claude_local",
      configuredModel: "   ",
      instanceAgentDefaults: {
        defaultModelByAdapterType: { claude_local: "claude-opus-4-7" },
      },
    });
    expect(resolved).toBe("claude-opus-4-7");
  });

  it("returns empty string when neither agent nor instance has a model", () => {
    const resolved = resolveAgentModelForRun({
      adapterType: "claude_local",
      configuredModel: "",
      instanceAgentDefaults: NO_DEFAULTS,
    });
    expect(resolved).toBe("");
  });

  it("does not cross-contaminate between adapter types", () => {
    const resolved = resolveAgentModelForRun({
      adapterType: "codex_local",
      configuredModel: "",
      instanceAgentDefaults: {
        defaultModelByAdapterType: { claude_local: "claude-opus-4-7" },
      },
    });
    expect(resolved).toBe("");
  });

  it("ignores non-string configured models", () => {
    const resolved = resolveAgentModelForRun({
      adapterType: "claude_local",
      configuredModel: 42 as unknown as string,
      instanceAgentDefaults: {
        defaultModelByAdapterType: { claude_local: "claude-opus-4-7" },
      },
    });
    expect(resolved).toBe("claude-opus-4-7");
  });

  it("documents Bedrock fallthrough: substitutes the default even though the adapter may drop it", () => {
    // The claude-local adapter's spawn code skips --model when auth is Bedrock
    // and the model isn't a Bedrock-native ID. This helper does NOT special-case
    // that — substitution always happens at the heartbeat layer, the adapter is
    // the layer that may decide not to honor the flag. See resolve-agent-model.ts
    // for the rationale.
    const resolved = resolveAgentModelForRun({
      adapterType: "claude_local",
      configuredModel: "",
      instanceAgentDefaults: {
        defaultModelByAdapterType: { claude_local: "claude-opus-4-7" },
      },
    });
    expect(resolved).toBe("claude-opus-4-7");
  });

  it("trims whitespace from instance defaults too", () => {
    const resolved = resolveAgentModelForRun({
      adapterType: "claude_local",
      configuredModel: "",
      instanceAgentDefaults: {
        defaultModelByAdapterType: { claude_local: "  claude-opus-4-7  " },
      },
    });
    expect(resolved).toBe("claude-opus-4-7");
  });
});
