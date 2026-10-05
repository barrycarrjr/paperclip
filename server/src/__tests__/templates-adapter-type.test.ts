import { describe, expect, it } from "vitest";
import { normalizeTemplateAdapterType } from "../services/templates.js";
import { BUILTIN_ADAPTER_TYPES } from "../adapters/builtin-adapter-types.js";

describe("normalizeTemplateAdapterType", () => {
  it("normalizes claude-local to claude_local", () => {
    expect(normalizeTemplateAdapterType("claude-local")).toBe("claude_local");
  });

  it("leaves claude_local unchanged", () => {
    expect(normalizeTemplateAdapterType("claude_local")).toBe("claude_local");
  });

  it("normalizes hyphenated built-in adapter types to their canonical underscored names", () => {
    expect(normalizeTemplateAdapterType("codex-local")).toBe("codex_local");
    expect(normalizeTemplateAdapterType("cursor-cloud")).toBe("cursor_cloud");
    expect(normalizeTemplateAdapterType("hermes-gateway")).toBe("hermes_gateway");
    expect(normalizeTemplateAdapterType("kimi-local")).toBe("kimi_local");
    expect(normalizeTemplateAdapterType("grok-local")).toBe("grok_local");
    expect(normalizeTemplateAdapterType("gemini-local")).toBe("gemini_local");
    expect(normalizeTemplateAdapterType("openclaw-gateway")).toBe("openclaw_gateway");
    expect(normalizeTemplateAdapterType("ollama-local")).toBe("ollama_local");
  });

  it("preserves non-builtin custom adapters unchanged", () => {
    expect(normalizeTemplateAdapterType("custom-adapter")).toBe("custom-adapter");
    expect(normalizeTemplateAdapterType("my-custom-runner")).toBe("my-custom-runner");
  });

  it("defaults null, undefined, or empty to process", () => {
    expect(normalizeTemplateAdapterType(null)).toBe("process");
    expect(normalizeTemplateAdapterType(undefined)).toBe("process");
    expect(normalizeTemplateAdapterType("")).toBe("process");
    expect(normalizeTemplateAdapterType("   ")).toBe("process");
  });

  it("handles all known built-in adapter types", () => {
    for (const builtin of BUILTIN_ADAPTER_TYPES) {
      // canonical form matches itself
      expect(normalizeTemplateAdapterType(builtin)).toBe(builtin);
      // hyphenated form normalizes to canonical
      const hyphenated = builtin.replace(/_/g, "-");
      expect(normalizeTemplateAdapterType(hyphenated)).toBe(builtin);
    }
  });
});
