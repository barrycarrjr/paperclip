import { describe, expect, it } from "vitest";
import { extractModelName, extractProviderId, formatDraftModelLabel } from "./model-utils";

describe("formatDraftModelLabel", () => {
  it("leaves a plain model id alone", () => {
    expect(formatDraftModelLabel("claude-opus-4-8")).toBe("claude-opus-4-8");
  });

  it("strips the adapter prefix and adapter type", () => {
    expect(formatDraftModelLabel("adapter:claude_local:claude-opus-4-8")).toBe("claude-opus-4-8");
  });

  it("keeps the raw id when the adapter prefix has no model part", () => {
    expect(formatDraftModelLabel("adapter:claude_local")).toBe("adapter:claude_local");
  });
});

describe("provider id helpers", () => {
  it("splits a slash-qualified model id", () => {
    expect(extractProviderId("anthropic/claude-opus-4-8")).toBe("anthropic");
    expect(extractModelName("anthropic/claude-opus-4-8")).toBe("claude-opus-4-8");
  });

  it("returns null when the id carries no provider", () => {
    expect(extractProviderId("claude-opus-4-8")).toBeNull();
  });
});
