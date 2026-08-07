import { describe, expect, it } from "vitest";
import { describeRunFailureCause, isSingleCauseFailure } from "./run-failure-cause.js";

describe("describeRunFailureCause", () => {
  it("explains an expired login in the operator's terms", () => {
    const cause = describeRunFailureCause("claude_auth_required");
    expect(cause?.summarize("Steward")).toBe("Steward cannot sign in to Claude Code");
    expect(cause?.retryCannotWork).toBe(true);
  });

  it("names the right product for each adapter", () => {
    expect(describeRunFailureCause("codex_auth_required")?.summarize("Scout")).toContain("Codex");
    expect(describeRunFailureCause("gemini_auth_required")?.summarize("Scout")).toContain("Gemini");
  });

  it("says retrying is fine for a timeout", () => {
    // Not every named cause is hopeless, and treating them alike would either
    // discourage a sensible retry or encourage a pointless one.
    expect(describeRunFailureCause("timeout")?.retryCannotWork).toBe(false);
  });

  it("says nothing about a code it does not know", () => {
    // Better than inventing advice for a failure nobody has characterised.
    expect(describeRunFailureCause("adapter_failed")).toBeNull();
    expect(describeRunFailureCause(null)).toBeNull();
    expect(describeRunFailureCause(undefined)).toBeNull();
    expect(describeRunFailureCause("")).toBeNull();
  });
});

describe("isSingleCauseFailure", () => {
  it("collapses the failures one fix would clear", () => {
    expect(isSingleCauseFailure("claude_auth_required")).toBe(true);
  });

  it("leaves failures that could each have their own reason alone", () => {
    // Two timeouts can be two different pieces of work being too big; two
    // uncharacterised crashes can be two different bugs. Merging them would
    // hide one behind the other.
    expect(isSingleCauseFailure("timeout")).toBe(false);
    expect(isSingleCauseFailure("adapter_failed")).toBe(false);
    expect(isSingleCauseFailure(null)).toBe(false);
  });
});
