import { describe, expect, it } from "vitest";
import { agentModelSelectionSchema, chooseRunModel, type AgentModelSelection } from "./model-selection.js";
import { agentRuntimeConfigSchema } from "./validators/agent.js";

const selection: AgentModelSelection = {
  enabled: true,
  allowedModels: ["light", "strong", "medium"],
  rules: [
    { labels: ["Legal"], model: "strong" },
    { priorities: ["critical", "high"], model: "medium" },
    { labels: ["bug"], priorities: ["low"], model: "light" },
  ],
};

function choose(overrides: Partial<Parameters<typeof chooseRunModel>[0]> = {}) {
  return chooseRunModel({
    selection,
    manualModel: null,
    agentModel: "light",
    task: { labels: [], priority: "medium" },
    ...overrides,
  });
}

describe("chooseRunModel", () => {
  it("uses the agent's own model when selection is off or missing", () => {
    expect(choose({ selection: undefined })).toEqual({
      model: "light",
      source: "agent-default",
      reason: "Agent's configured model",
    });
    expect(choose({ selection: { ...selection, enabled: false } }).source).toBe("agent-default");
    expect(choose({ selection: undefined, agentModel: null })).toEqual({
      model: null,
      source: "agent-default",
      reason: "Adapter's default model",
    });
  });

  it("lets a model set on the task win over every rule", () => {
    expect(choose({ manualModel: "manual-pick", task: { labels: ["legal"], priority: "high" } })).toEqual({
      model: "manual-pick",
      source: "manual",
      reason: "Model set on this task",
    });
  });

  it("picks the first matching rule and says what matched", () => {
    expect(choose({ task: { labels: ["legal"], priority: "high" } })).toEqual({
      model: "strong",
      source: "rule",
      reason: "label `Legal` matched rule 1",
    });
    expect(choose({ task: { labels: [], priority: "critical" } })).toEqual({
      model: "medium",
      source: "rule",
      reason: "priority `critical` matched rule 2",
    });
  });

  it("needs every condition of a rule to hold", () => {
    expect(choose({ task: { labels: ["bug"], priority: "medium" } }).source).toBe("fallback");
    expect(choose({ task: { labels: ["bug"], priority: "low" } })).toEqual({
      model: "light",
      source: "rule",
      reason: "label `bug` and priority `low` matched rule 3",
    });
  });

  it("falls back to the fallback model, then the agent's model, then the first allowed model", () => {
    expect(choose({ selection: { ...selection, fallbackModel: "medium" } })).toEqual({
      model: "medium",
      source: "fallback",
      reason: "No rule matched; fallback model",
    });
    expect(choose()).toEqual({
      model: "light",
      source: "fallback",
      reason: "No rule matched; agent's configured model",
    });
    expect(choose({ agentModel: "not-allowed" })).toEqual({
      model: "light",
      source: "fallback",
      reason: "No rule matched and the agent's model is not allowed; first allowed model",
    });
  });

  it("never picks a model outside the allowed list, even from a stale stored rule", () => {
    const stale = {
      enabled: true,
      allowedModels: ["light"],
      rules: [{ labels: ["legal"], model: "strong" }],
    };
    // Stored settings that fail validation are treated as off.
    expect(choose({ selection: stale, task: { labels: ["legal"], priority: "high" } }).source).toBe("agent-default");
    const picks = [
      choose({ task: { labels: ["legal"], priority: "low" } }),
      choose({ task: { labels: [], priority: "high" } }),
      choose({ agentModel: "elsewhere" }),
    ];
    for (const pick of picks) expect(selection.allowedModels).toContain(pick.model);
  });

  it("uses the agent's model for a run with no task", () => {
    expect(choose({ task: null })).toEqual({
      model: "light",
      source: "agent-default",
      reason: "Agent's configured model; run has no task to apply rules to",
    });
  });
});

describe("agentModelSelectionSchema", () => {
  it("accepts a valid setting", () => {
    expect(agentModelSelectionSchema.safeParse({ ...selection, fallbackModel: "light" }).success).toBe(true);
  });

  it("refuses rule and fallback models outside the allowed list", () => {
    const result = agentModelSelectionSchema.safeParse({
      enabled: true,
      allowedModels: ["light"],
      rules: [{ labels: ["legal"], model: "strong" }],
      fallbackModel: "medium",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual(["rules.0.model", "fallbackModel"]);
  });

  it("refuses turning selection on with no allowed models, and a rule with no condition", () => {
    expect(agentModelSelectionSchema.safeParse({ enabled: true, allowedModels: [], rules: [] }).success).toBe(false);
    expect(agentModelSelectionSchema.safeParse({ enabled: false, allowedModels: [], rules: [] }).success).toBe(true);
    expect(
      agentModelSelectionSchema.safeParse({ enabled: true, allowedModels: ["light"], rules: [{ model: "light" }] }).success,
    ).toBe(false);
  });

  it("is checked when an agent's runtime config is saved", () => {
    expect(agentRuntimeConfigSchema.safeParse({ modelSelection: selection }).success).toBe(true);
    expect(agentRuntimeConfigSchema.safeParse({ modelSelection: null }).success).toBe(true);
    expect(
      agentRuntimeConfigSchema.safeParse({ modelSelection: { enabled: true, allowedModels: [], rules: [] } }).success,
    ).toBe(false);
  });
});
