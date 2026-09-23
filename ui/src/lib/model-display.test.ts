import { describe, expect, it } from "vitest";
import { describeSavedModel, type ModelListEntry } from "@paperclipai/shared";
import {
  buildModelPickerSections,
  chatModelEntry,
  formatModelShortDate,
  groupModelsByProvider,
  modelLifecycleTags,
  parseModelDate,
  savedModelNotice,
} from "./model-display";

const NOW = new Date(2026, 8, 23, 12, 0, 0);

// Shaped like the real claude_local and codex_local answers, trimmed down.
const MODELS: ModelListEntry[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", status: "current", isDefault: true, isNew: true, releasedAt: "2026-09-22" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", status: "current" },
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    status: "deprecated",
    retiresAt: "2026-10-14T12:00:00.000Z",
    replacementId: "claude-sonnet-5",
    notice: "GPT-5.5 retires on October 14, 2026. Switch to Claude Sonnet 5 to keep working.",
  },
  { id: "claude-opus-5", label: "Claude Opus 5", status: "legacy", replacementId: "claude-opus-5-5" },
];

describe("modelLifecycleTags", () => {
  it("gives a plain current model no tags", () => {
    expect(modelLifecycleTags({ status: "current" }, NOW)).toEqual([]);
    // Adapters with no lifecycle facts at all read as plain current.
    expect(modelLifecycleTags({}, NOW)).toEqual([]);
  });

  it("tags a new default model New then Default", () => {
    expect(modelLifecycleTags(MODELS[0], NOW).map((tag) => tag.label)).toEqual(["New", "Used by default"]);
  });

  it("dates a retiring model, and says Retiring when there is no date", () => {
    expect(modelLifecycleTags(MODELS[2], NOW).map((tag) => tag.label)).toEqual(["Retires Oct 14"]);
    expect(modelLifecycleTags({ status: "deprecated" }, NOW).map((tag) => tag.label)).toEqual(["Retiring"]);
  });

  it("uses the provider's own notice for the hover text of a retiring model", () => {
    expect(modelLifecycleTags(MODELS[2], NOW)[0].title).toBe(MODELS[2].notice);
  });

  it("leaves older models untagged, even one still marked new", () => {
    expect(modelLifecycleTags({ status: "legacy", isNew: true }, NOW)).toEqual([]);
  });
});

describe("model dates", () => {
  it("reads a bare release date as that day, not the day before", () => {
    const date = parseModelDate("2026-09-22");
    expect(date?.getFullYear()).toBe(2026);
    expect(date?.getMonth()).toBe(8);
    expect(date?.getDate()).toBe(22);
  });

  it("adds the year only when it is not this year", () => {
    expect(formatModelShortDate("2026-10-14", NOW)).toBe("Oct 14");
    expect(formatModelShortDate("2027-01-05", NOW)).toBe("Jan 5, 2027");
    expect(formatModelShortDate("not a date", NOW)).toBeNull();
  });
});

describe("savedModelNotice", () => {
  it("says an older model has been replaced, and offers the replacement", () => {
    const notice = savedModelNotice(describeSavedModel(MODELS, "claude-opus-5"), "claude-opus-5");
    expect(notice?.tone).toBe("info");
    expect(notice?.message).toBe("Claude Opus 5 has been replaced by Claude Opus 5.5.");
    expect(notice?.replacement?.id).toBe("claude-opus-5-5");
  });

  it("uses the provider's notice for a retiring model", () => {
    const notice = savedModelNotice(describeSavedModel(MODELS, "gpt-5.5"), "gpt-5.5");
    expect(notice?.tone).toBe("warning");
    expect(notice?.message).toBe(MODELS[2].notice);
    expect(notice?.replacement?.id).toBe("claude-sonnet-5");
  });

  it("gives the retirement date when the provider wrote no notice", () => {
    const models = [MODELS[0], { ...MODELS[2], notice: undefined }];
    const notice = savedModelNotice(describeSavedModel(models, "gpt-5.5"), "gpt-5.5");
    expect(notice?.message).toBe("GPT-5.5 retires on Oct 14, 2026.");
  });

  it("names a model the provider no longer offers by its saved id", () => {
    const notice = savedModelNotice(describeSavedModel(MODELS, "claude-opus-4-7"), "claude-opus-4-7");
    expect(notice?.tone).toBe("danger");
    expect(notice?.message).toBe("claude-opus-4-7 is not in the models this provider offers right now.");
    // The newest current model of the same family.
    expect(notice?.replacement?.id).toBe("claude-opus-5-5");
  });

  it("says nothing for the default, a list still loading, or a model that is fine", () => {
    expect(savedModelNotice(describeSavedModel(MODELS, ""), "")).toBeNull();
    expect(savedModelNotice(describeSavedModel([], "claude-opus-5"), "claude-opus-5")).toBeNull();
    expect(savedModelNotice(describeSavedModel(MODELS, "claude-sonnet-5"), "claude-sonnet-5")).toBeNull();
  });
});

describe("buildModelPickerSections", () => {
  it("keeps the server's order and folds older models apart", () => {
    const [section] = buildModelPickerSections([{ key: "models", models: MODELS }]);
    expect(section.primary.map((m) => m.id)).toEqual(["claude-opus-5-5", "claude-sonnet-5", "gpt-5.5"]);
    expect(section.older.map((m) => m.id)).toEqual(["claude-opus-5"]);
  });

  it("narrows every group to the search and drops groups with nothing left", () => {
    const sections = buildModelPickerSections(
      [
        { key: "a", label: "Anthropic", models: MODELS.filter((m) => m.id.startsWith("claude")) },
        { key: "b", label: "OpenAI", models: MODELS.filter((m) => m.id.startsWith("gpt")) },
      ],
      "opus",
    );
    expect(sections.map((s) => s.key)).toEqual(["a"]);
    expect(sections[0].primary.map((m) => m.id)).toEqual(["claude-opus-5-5"]);
    expect(sections[0].older.map((m) => m.id)).toEqual(["claude-opus-5"]);
  });

  it("matches a search on the group heading", () => {
    const sections = buildModelPickerSections([{ key: "b", label: "OpenAI", models: [MODELS[2]] }], "openai");
    expect(sections).toHaveLength(1);
  });
});

describe("groupModelsByProvider", () => {
  it("groups provider/model ids under each provider, providers in alphabetical order", () => {
    const groups = groupModelsByProvider([
      { id: "openai/gpt-6", label: "openai/gpt-6" },
      { id: "anthropic/claude-sonnet-5", label: "anthropic/claude-sonnet-5" },
      { id: "openai/gpt-5.5", label: "openai/gpt-5.5" },
    ]);
    expect(groups.map((g) => g.label)).toEqual(["anthropic", "openai"]);
    expect(groups[1].models.map((m) => m.shortLabel)).toEqual(["gpt-6", "gpt-5.5"]);
  });
});

describe("chatModelEntry", () => {
  it("uses the provider's name, or the bare id when there is none", () => {
    expect(chatModelEntry({ provider: "anthropic", model: "claude-sonnet-5", label: "Claude Sonnet 5" }).label).toBe(
      "Claude Sonnet 5",
    );
    expect(
      chatModelEntry({ provider: "adapter", model: "adapter:ollama_local:llama4", source: "ollama_local" }).label,
    ).toBe("llama4");
  });

  it("writes an adapter-routed replacement the way the rows are written, so it can be found", () => {
    const entry = chatModelEntry({
      provider: "adapter",
      model: "adapter:codex_local:gpt-5.5",
      source: "codex_local",
      status: "deprecated",
      replacementId: "gpt-6-sol",
    });
    expect(entry.id).toBe("adapter:codex_local:gpt-5.5");
    expect(entry.replacementId).toBe("adapter:codex_local:gpt-6-sol");
    expect(entry.status).toBe("deprecated");
  });
});
