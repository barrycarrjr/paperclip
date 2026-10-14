import { describe, expect, it } from "vitest";
import { parseClaudeStreamJson } from "./parse.js";
import { combineClaudeUsage } from "./advisor-usage.js";
const nativeRow = { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, costUSD: 0.006 };
const report = (extra: Record<string, unknown> = {}) => parseClaudeStreamJson(JSON.stringify({ type: "result", usage: {}, total_cost_usd: 0.006, modelUsage: { primary: nativeRow }, ...extra }));
describe("native Claude advisor accounting", () => {
  it("preserves exact native model totals without assigning the map's call roles", () => {
    const parsed = report();
    expect(parsed.modelUsage?.primary).toEqual({ inputTokens: 10, outputTokens: 2, cachedInputTokens: 3, cacheCreationInputTokens: 4, costUsd: 0.006 });
    expect(parsed.resolvedAdvisorModel).toBeNull();
    expect(parsed.observedAdvisorModels).toEqual([]);
  });
  it("reads explicitly observed advisor iterations separately from per-model totals", () => {
    const parsed = parseClaudeStreamJson([
      JSON.stringify({ type: "assistant", advisorModel: "resolved-reviewer", message: { usage: { iterations: [{ type: "advisor_message", model: "resolved-reviewer" }] } } }),
      JSON.stringify({ type: "result", modelUsage: { primary: nativeRow }, usage: {}, total_cost_usd: 0.006 }),
    ].join("\n"));
    expect(parsed.resolvedAdvisorModel).toBe("resolved-reviewer");
    expect(parsed.observedAdvisorModels).toEqual(["resolved-reviewer"]);
  });
  it("combines separate process attempts once, including a paid failed attempt", () => {
    const combined = combineClaudeUsage([report({ is_error: true }), report()]);
    expect(combined.costUsd).toBe(0.012);
    expect(combined.modelUsage?.primary.inputTokens).toBe(20);
    expect(combined.usage).toEqual({ inputTokens: 28, outputTokens: 4, cachedInputTokens: 6 });
    const latest = parseClaudeStreamJson([JSON.stringify({ type: "result", usage: {}, total_cost_usd: 9 }), JSON.stringify({ type: "result", usage: {}, total_cost_usd: 0.006, modelUsage: { primary: nativeRow } })].join("\n"));
    expect(combineClaudeUsage([latest]).costUsd).toBe(0.006);
  });
  it("retains reported aggregate cost and unknown attribution if any consumed report is malformed", () => {
    const combined = combineClaudeUsage([report(), report({ modelUsage: { primary: { ...nativeRow, outputTokens: NaN } } })]);
    expect(combined.costUsd).toBe(0.012);
    expect(combined.modelUsage).toBeNull();
    expect(combined.usage).toBeNull();
    expect(combined.knownUsage).toEqual({ inputTokens: 14, outputTokens: 2, cachedInputTokens: 3 });
  });
  it("allows an explicitly zero-cost empty startup failure but leaves absent cost unknown", () => {
    expect(combineClaudeUsage([report({ modelUsage: {}, total_cost_usd: 0 }), report()]).modelUsage).not.toBeNull();
    expect(combineClaudeUsage([report({ modelUsage: {}, total_cost_usd: undefined }), report()]).costUsd).toBeNull();
    const cacheWrite = report({ modelUsage: {}, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 2 } });
    expect(combineClaudeUsage([cacheWrite, report()]).modelUsage).toBeNull();
    expect(combineClaudeUsage([cacheWrite, report()]).usage?.inputTokens).toBe(16);
  });
  it("does not treat omitted or malformed native aggregate counters as a complete zero report", () => {
    const missing = combineClaudeUsage([report({ modelUsage: undefined, usage: undefined })]);
    expect(missing.usage).toBeNull(); expect(missing.knownUsage).toBeNull();
    const malformed = combineClaudeUsage([report({ modelUsage: undefined, usage: { input_tokens: "1", output_tokens: 0 } })]);
    expect(malformed.usage).toBeNull();
  });
});
