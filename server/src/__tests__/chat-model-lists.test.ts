import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalog } from "../services/model-catalog.js";

const state = vi.hoisted(() => ({
  catalog: null as ModelCatalog | null,
  anthropic: null as Array<{ id: string; label: string }> | null,
  anthropicCalls: 0,
}));

vi.mock("../services/model-catalog.js", () => ({
  getModelCatalog: async () => state.catalog,
  lookupCatalogModel: (catalog: ModelCatalog | null, provider: string, id: string) =>
    catalog?.providers[provider]?.[id] ?? null,
}));
vi.mock("../adapters/claude-models.js", () => ({
  fetchAnthropicModelsFromApi: async () => {
    state.anthropicCalls += 1;
    return state.anthropic;
  },
}));
vi.mock("../adapters/codex-models.js", () => ({
  fetchOpenAiChatModels: async () => [
    { id: "gpt-6-astra", label: "gpt-6-astra" },
    { id: "gpt-5.5-pro", label: "gpt-5.5-pro" },
    { id: "gpt-5.3-codex", label: "gpt-5.3-codex" },
    { id: "gpt-5.5", label: "gpt-5.5" },
  ],
}));
vi.mock("../adapters/gemini-models.js", () => ({ fetchLiveGeminiModels: async () => null }));

import {
  bestKnownNativeModel,
  knownImageSupport,
  listNativeChatModels,
  resetChatModelListsForTests,
} from "../services/chat-model-lists.js";

const CATALOG: ModelCatalog = {
  source: "test",
  fetchedAt: "2026-09-23T00:00:00Z",
  providers: {
    anthropic: {
      "claude-opus-5-5": { id: "claude-opus-5-5", name: "Claude Opus 5.5", family: "claude-opus", releaseDate: "2026-09-22", supportsImages: true },
      "claude-opus-5": { id: "claude-opus-5", family: "claude-opus", releaseDate: "2026-07-24" },
      "claude-sonnet-5": { id: "claude-sonnet-5", family: "claude-sonnet", releaseDate: "2026-06-29" },
    },
    openai: {
      "gpt-6-astra": { id: "gpt-6-astra", family: "gpt-astra", releaseDate: "2026-09-04", supportsImages: true },
    },
  },
};

describe("direct provider model lists for Clippy", () => {
  beforeEach(() => {
    resetChatModelListsForTests();
    state.catalog = null;
    state.anthropic = null;
    state.anthropicCalls = 0;
  });
  afterEach(() => vi.restoreAllMocks());

  it("uses the provider's own list, marked from the catalog, and caches it per key", async () => {
    state.catalog = CATALOG;
    state.anthropic = [
      { id: "claude-opus-5", label: "Claude Opus 5" },
      { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
    ];
    const models = await listNativeChatModels("anthropic", "sk-ant-one");
    expect(models.map((m) => [m.id, m.status])).toEqual([
      ["claude-opus-5-5", "current"],
      ["claude-opus-5", "legacy"],
    ]);
    await listNativeChatModels("anthropic", "sk-ant-one");
    expect(state.anthropicCalls).toBe(1);
    await listNativeChatModels("anthropic", "sk-ant-two");
    expect(state.anthropicCalls).toBe(2);
  });

  it("falls back to the catalog's current models when the provider cannot be read", async () => {
    state.catalog = CATALOG;
    const models = await listNativeChatModels("anthropic", "sk-ant-bad");
    expect(models.map((m) => m.id).sort()).toEqual(["claude-opus-5-5", "claude-sonnet-5"]);
  });

  it("falls back to the built-in list with neither, newest current first", async () => {
    const models = await listNativeChatModels("anthropic", "sk-ant-bad");
    expect(models[0]).toMatchObject({ id: "claude-opus-5-5", status: "current" });
  });

  it("answers the default synchronously from the last list, or the built-in list before any", async () => {
    expect(bestKnownNativeModel("anthropic")).toBe("claude-opus-5-5");
    state.anthropic = [
      { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
      { id: "claude-opus-5", label: "Claude Opus 5" },
    ];
    await listNativeChatModels("anthropic", "sk-ant-one");
    expect(bestKnownNativeModel("anthropic")).toBe("claude-opus-5");
  });

  it("leaves OpenAI models Clippy cannot talk to (Responses-only -pro and Codex models) out of its list", async () => {
    const models = await listNativeChatModels("openai", "sk-openai");
    expect(models.map((m) => m.id).sort()).toEqual(["gpt-5.5", "gpt-6-astra"]);
  });

  it("knows image support from lists and the catalog, and says nothing when neither knows", async () => {
    state.catalog = CATALOG;
    expect(knownImageSupport("gpt-6-astra", CATALOG)).toBe(true);
    expect(knownImageSupport("mystery-model", CATALOG)).toBeNull();
  });
});
