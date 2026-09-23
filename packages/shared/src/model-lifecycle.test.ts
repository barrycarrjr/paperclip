import { describe, expect, it } from "vitest";
import {
  describeSavedModel,
  findModelInList,
  groupModelsForPicker,
  guessModelFamily,
  normalizeModelId,
  stripModelSnapshotDate,
  type ModelListEntry,
} from "./model-lifecycle.js";

const claudeList: ModelListEntry[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", status: "current", isDefault: true, aliases: ["opus"] },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1", status: "current" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", status: "current", aliases: ["claude-haiku-4-5-20251001"] },
  { id: "claude-opus-5", label: "Claude Opus 5", status: "legacy", replacementId: "claude-opus-5-5" },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", status: "legacy" },
];

const codexList: ModelListEntry[] = [
  { id: "gpt-6-astra", label: "GPT-6-Astra", status: "current", isDefault: true },
  { id: "gpt-6-sol", label: "GPT-6-Sol", status: "current" },
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    status: "deprecated",
    retiresAt: "2026-10-14T07:00:00.000Z",
    replacementId: "gpt-5.6-sol",
  },
  { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", status: "legacy" },
];

describe("normalizeModelId and stripModelSnapshotDate", () => {
  it("drops a context-window suffix and case", () => {
    expect(normalizeModelId(" Claude-Opus-5-5[1m] ")).toBe("claude-opus-5-5");
  });

  it("drops only a real snapshot date, in Anthropic's and OpenAI's forms", () => {
    expect(stripModelSnapshotDate("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(stripModelSnapshotDate("gpt-5-2025-08-07")).toBe("gpt-5");
    expect(stripModelSnapshotDate("gpt-4o-2024-11-20")).toBe("gpt-4o");
    expect(stripModelSnapshotDate("claude-opus-4-5")).toBe("claude-opus-4-5");
    expect(stripModelSnapshotDate("model-20251399")).toBe("model-20251399");
    expect(stripModelSnapshotDate("model-2025-13-01")).toBe("model-2025-13-01");
  });
});

describe("findModelInList", () => {
  it("matches the id, an alias, a context suffix and a dated snapshot", () => {
    expect(findModelInList(claudeList, "claude-fable-5-1")?.id).toBe("claude-fable-5-1");
    expect(findModelInList(claudeList, "opus")?.id).toBe("claude-opus-5-5");
    expect(findModelInList(claudeList, "claude-opus-5-5[1m]")?.id).toBe("claude-opus-5-5");
    expect(findModelInList(claudeList, "claude-haiku-4-5-20251001")?.id).toBe("claude-haiku-4-5");
  });

  it("does not confuse neighbouring versions", () => {
    expect(findModelInList(claudeList, "claude-opus-4-7")).toBeNull();
    expect(findModelInList(claudeList, "claude-opus-5-1")).toBeNull();
  });

  it("returns null for blank ids", () => {
    expect(findModelInList(claudeList, "")).toBeNull();
    expect(findModelInList(claudeList, null)).toBeNull();
  });
});

describe("guessModelFamily", () => {
  it("reads Claude families and gives up on other shapes", () => {
    expect(guessModelFamily("claude-opus-4-8")).toBe("claude-opus");
    expect(guessModelFamily("claude-fable-5-1[1m]")).toBe("claude-fable");
    expect(guessModelFamily("gpt-6-astra")).toBeNull();
  });
});

describe("describeSavedModel", () => {
  it("treats a blank model as the adapter default and an empty list as unknown", () => {
    expect(describeSavedModel(claudeList, "")).toEqual({ kind: "default" });
    expect(describeSavedModel([], "claude-opus-5-5")).toEqual({ kind: "unknown" });
  });

  it("reports a current model as available", () => {
    expect(describeSavedModel(claudeList, "claude-fable-5-1").kind).toBe("available");
  });

  it("suggests the named successor for a legacy model", () => {
    const state = describeSavedModel(claudeList, "claude-opus-5");
    expect(state.kind).toBe("legacy");
    expect(state.kind === "legacy" && state.replacement?.id).toBe("claude-opus-5-5");
  });

  it("falls back to the newest current model in the family for a legacy model with no successor", () => {
    const state = describeSavedModel(claudeList, "claude-opus-4-8");
    expect(state.kind === "legacy" && state.replacement?.id).toBe("claude-opus-5-5");
  });

  it("reports a retiring model with the provider's replacement", () => {
    const state = describeSavedModel([...codexList, { id: "gpt-5.6-sol", label: "x" }], "gpt-5.5");
    expect(state.kind).toBe("retiring");
    expect(state.kind === "retiring" && state.replacement?.id).toBe("gpt-5.6-sol");
  });

  it("follows a named successor that has itself been replaced on to a current model", () => {
    const chain: ModelListEntry[] = [
      { id: "gpt-6-sol", label: "GPT-6-Sol", status: "current" },
      { id: "gpt-5.5", label: "GPT-5.5", status: "deprecated", replacementId: "gpt-5.6-sol" },
      { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", status: "legacy", replacementId: "gpt-6-sol" },
    ];
    const state = describeSavedModel(chain, "gpt-5.5");
    expect(state.kind === "retiring" && state.replacement?.id).toBe("gpt-6-sol");
  });

  it("stops on a successor loop instead of spinning", () => {
    const loop: ModelListEntry[] = [
      { id: "a-1", label: "A1", status: "legacy", replacementId: "a-2" },
      { id: "a-2", label: "A2", status: "legacy", replacementId: "a-1" },
    ];
    const state = describeSavedModel(loop, "a-1");
    expect(state.kind).toBe("legacy");
  });

  it("reports a model missing from the list as unavailable, suggesting the family's newest or the default", () => {
    const claude = describeSavedModel(claudeList, "claude-opus-4-1");
    expect(claude).toEqual({ kind: "unavailable", replacement: claudeList[0] });
    const codex = describeSavedModel(codexList, "gpt-5.3-codex");
    expect(codex.kind === "unavailable" && codex.replacement?.id).toBe("gpt-6-astra");
  });
});

describe("groupModelsForPicker", () => {
  it("keeps current and retiring models up front and folds legacy ones away, in order", () => {
    const { primary, older } = groupModelsForPicker(codexList);
    expect(primary.map((m) => m.id)).toEqual(["gpt-6-astra", "gpt-6-sol", "gpt-5.5"]);
    expect(older.map((m) => m.id)).toEqual(["gpt-5.6-sol"]);
  });
});
