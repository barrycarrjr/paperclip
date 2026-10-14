import { describe, expect, it } from "vitest";
import { appendSourceEvidenceInstructions, SOURCE_EVIDENCE_INSTRUCTIONS } from "./source-evidence.js";
import { joinPromptSections } from "./server-utils.js";

describe("source evidence prompt composition", () => {
  it("preserves custom prompt bytes and adds the guidance to an empty or populated prompt", () => {
    const custom = "Custom instructions\n  Preserve this spacing.\n";
    const prompt = appendSourceEvidenceInstructions(custom);
    expect(prompt.startsWith(custom)).toBe(true);
    expect(prompt.slice(custom.length)).toBe(`\n\n${SOURCE_EVIDENCE_INSTRUCTIONS}`);
    expect(appendSourceEvidenceInstructions("")).toBe(SOURCE_EVIDENCE_INSTRUCTIONS);
  });

  it("does not repeat guidance when onboarding instructions and runtime context are composed again", () => {
    const onboarding = appendSourceEvidenceInstructions("Default agent instructions.");
    const composed = joinPromptSections([onboarding, "New wake: check the invoice notes."]);
    const runtime = appendSourceEvidenceInstructions(composed);
    expect(runtime).toBe(composed);
    expect(appendSourceEvidenceInstructions(runtime)).toBe(runtime);
    expect(runtime.split(SOURCE_EVIDENCE_INSTRUCTIONS)).toHaveLength(2);
  });

  it("uses a delivered instruction channel without stripping any custom prompt content", () => {
    const task = "Custom task.\n  Preserve this spacing.";
    const core = appendSourceEvidenceInstructions("Trusted loaded core.");
    expect(appendSourceEvidenceInstructions(task, core)).toBe(task);
    expect(appendSourceEvidenceInstructions(task, null)).toContain(SOURCE_EVIDENCE_INSTRUCTIONS);
    expect(appendSourceEvidenceInstructions(task, "A configured filename is not loaded content.")).toContain(SOURCE_EVIDENCE_INSTRUCTIONS);
    const repeatedCustom = `${SOURCE_EVIDENCE_INSTRUCTIONS}\nCustom quote\n${SOURCE_EVIDENCE_INSTRUCTIONS}`;
    expect(appendSourceEvidenceInstructions(repeatedCustom, core)).toBe(repeatedCustom);
  });
});
