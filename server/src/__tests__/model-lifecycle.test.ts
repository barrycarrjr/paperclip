import { describe, expect, it } from "vitest";
import type { ModelCatalog } from "../services/model-catalog.js";
import {
  buildModelList,
  compareModelRecency,
  modelFamilyTier,
  modelVersionParts,
  rankModelsForDefault,
} from "../services/model-lifecycle.js";

const NOW = new Date("2026-09-23T12:00:00Z");

// A trimmed copy of what models.dev said about Anthropic on 2026-09-23.
const catalog: ModelCatalog = {
  source: "test",
  fetchedAt: NOW.toISOString(),
  providers: {
    anthropic: {
      "claude-opus-5-5": { id: "claude-opus-5-5", name: "Claude Opus 5.5", family: "claude-opus", releaseDate: "2026-09-22", supportsImages: true },
      "claude-fable-5-1": { id: "claude-fable-5-1", name: "Claude Fable 5.1", family: "claude-fable", releaseDate: "2026-09-01", supportsImages: true },
      "claude-opus-5": { id: "claude-opus-5", name: "Claude Opus 5", family: "claude-opus", releaseDate: "2026-07-24", supportsImages: true },
      "claude-sonnet-5": { id: "claude-sonnet-5", name: "Claude Sonnet 5", family: "claude-sonnet", releaseDate: "2026-06-29", supportsImages: true },
      "claude-fable-5": { id: "claude-fable-5", name: "Claude Fable 5", family: "claude-fable", releaseDate: "2026-06-07", supportsImages: true },
      "claude-opus-4-8": { id: "claude-opus-4-8", name: "Claude Opus 4.8", family: "claude-opus", releaseDate: "2026-05-28" },
      "claude-opus-4-5": { id: "claude-opus-4-5", name: "Claude Opus 4.5 (latest)", family: "claude-opus", releaseDate: "2025-11-24" },
      "claude-opus-4-5-20251101": { id: "claude-opus-4-5-20251101", name: "Claude Opus 4.5", family: "claude-opus", releaseDate: "2025-11-24" },
      "claude-haiku-4-5": { id: "claude-haiku-4-5", name: "Claude Haiku 4.5 (latest)", family: "claude-haiku", releaseDate: "2025-10-15" },
      "claude-haiku-4-5-20251001": { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", family: "claude-haiku", releaseDate: "2025-10-15" },
    },
    openai: {
      "gpt-6-sol": { id: "gpt-6-sol", family: "gpt-sol", releaseDate: "2026-09-22" },
      "gpt-6-astra": { id: "gpt-6-astra", family: "gpt-astra", releaseDate: "2026-09-04" },
      "gpt-5.6-sol": { id: "gpt-5.6-sol", family: "gpt-sol", releaseDate: "2026-07-09" },
      "gpt-5.5": { id: "gpt-5.5", family: "gpt", releaseDate: "2026-04-23" },
      "o4-mini": { id: "o4-mini", family: "o-mini", releaseDate: "2025-04-16", status: "deprecated" },
    },
  },
};

// What the Claude Code CLI's initialize handshake gave on 2026-09-23, after mapping.
const claudeCli = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", isDefault: true, aliases: ["opus", "opus[1m]"] },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1", aliases: ["claude-fable-5-1[1m]"] },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", aliases: ["sonnet"] },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", aliases: ["haiku", "claude-haiku-4-5-20251001"] },
];

describe("buildModelList: a CLI that lists only current models, plus the catalog's older ones", () => {
  const { models, needsNewerTool } = buildModelList({
    live: claudeCli,
    catalog,
    catalogProvider: "anthropic",
    catalogAdditions: "older",
    keepLiveOrder: true,
    now: NOW,
  });
  const byId = new Map(models.map((m) => [m.id, m]));

  it("keeps the CLI's models current, in the CLI's own order, first", () => {
    expect(models.slice(0, 4).map((m) => m.id)).toEqual([
      "claude-opus-5-5",
      "claude-fable-5-1",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ]);
    expect(models.slice(0, 4).every((m) => m.status === "current")).toBe(true);
    expect(byId.get("claude-opus-5-5")?.isDefault).toBe(true);
  });

  it("adds the older models the CLI still runs, marked legacy with the family's newest as successor", () => {
    expect(byId.get("claude-opus-5")).toMatchObject({ status: "legacy", replacementId: "claude-opus-5-5" });
    expect(byId.get("claude-fable-5")).toMatchObject({ status: "legacy", replacementId: "claude-fable-5-1" });
    expect(byId.get("claude-opus-4-8")).toMatchObject({ status: "legacy", replacementId: "claude-opus-5-5" });
  });

  it("orders older models newest first and never lists a dated snapshot next to its alias", () => {
    const older = models.filter((m) => m.status === "legacy").map((m) => m.id);
    expect(older).toEqual(["claude-opus-5", "claude-fable-5", "claude-opus-4-8", "claude-opus-4-5"]);
    expect(byId.has("claude-opus-4-5-20251101")).toBe(false);
    expect(byId.has("claude-haiku-4-5-20251001")).toBe(false);
  });

  it("flags models released in the last 30 days as new, and only current ones", () => {
    expect(byId.get("claude-opus-5-5")?.isNew).toBe(true);
    expect(byId.get("claude-fable-5-1")?.isNew).toBe(true);
    expect(byId.get("claude-sonnet-5")?.isNew).toBeUndefined();
  });

  it("takes release dates and image support from the catalog, and cleans '(latest)' out of names", () => {
    expect(byId.get("claude-sonnet-5")).toMatchObject({ releasedAt: "2026-06-29", supportsImages: true });
    expect(byId.get("claude-opus-4-5")?.label).toBe("Claude Opus 4.5");
  });

  it("reports nothing as needing a newer CLI when the CLI already offers the newest release", () => {
    expect(needsNewerTool).toEqual([]);
  });
});

describe("buildModelList: a CLI that has not caught up with a release", () => {
  it("leaves out a model newer than anything the CLI offers in its family and reports it", () => {
    const olderCli = claudeCli.map((m) =>
      m.id === "claude-opus-5-5" ? { id: "claude-opus-5", label: "Claude Opus 5", isDefault: true } : m,
    );
    const { models, needsNewerTool } = buildModelList({
      live: olderCli,
      catalog,
      catalogProvider: "anthropic",
      catalogAdditions: "older",
      keepLiveOrder: true,
      now: NOW,
    });
    expect(needsNewerTool).toEqual(["claude-opus-5-5"]);
    expect(models.some((m) => m.id === "claude-opus-5-5")).toBe(false);
    expect(models.find((m) => m.id === "claude-opus-5")?.status).toBe("current");
  });
});

describe("buildModelList: a live list that carries retirement data (Codex)", () => {
  const { models } = buildModelList({
    live: [
      { id: "gpt-6-astra", label: "GPT-6-Astra", isDefault: true },
      { id: "gpt-6-sol", label: "GPT-6-Sol" },
      { id: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
      {
        id: "gpt-5.5",
        label: "GPT-5.5",
        retiresAt: "2026-10-14T19:00:00.000Z",
        replacementId: "gpt-5.6-sol",
        notice: "GPT-5.5 retires on October 14, 2026.",
      },
    ],
    catalog,
    catalogProvider: "openai",
    keepLiveOrder: true,
    now: NOW,
  });
  const byId = new Map(models.map((m) => [m.id, m]));

  it("marks the retiring model deprecated with the provider's own successor, date and notice", () => {
    expect(byId.get("gpt-5.5")).toMatchObject({
      status: "deprecated",
      replacementId: "gpt-5.6-sol",
      retiresAt: "2026-10-14T19:00:00.000Z",
      notice: "GPT-5.5 retires on October 14, 2026.",
    });
  });

  it("marks a model superseded within its family as legacy, and keeps the default current", () => {
    expect(byId.get("gpt-5.6-sol")).toMatchObject({ status: "legacy", replacementId: "gpt-6-sol" });
    expect(byId.get("gpt-6-astra")).toMatchObject({ status: "current", isDefault: true });
  });

  it("orders current, then retiring, then older", () => {
    expect(models.map((m) => m.id)).toEqual(["gpt-6-astra", "gpt-6-sol", "gpt-5.5", "gpt-5.6-sol"]);
  });

  it("treats the catalog's deprecated flag as a retirement", () => {
    const built = buildModelList({ live: [{ id: "o4-mini" }], catalog, catalogProvider: "openai", now: NOW });
    expect(built.models[0].status).toBe("deprecated");
  });
});

describe("buildModelList: no live source at all", () => {
  it("builds from the catalog alone, with the newest of each family current", () => {
    const { models } = buildModelList({
      live: [],
      catalog,
      catalogProvider: "anthropic",
      catalogAdditions: "all",
      now: NOW,
    });
    const current = models.filter((m) => m.status === "current").map((m) => m.id).sort();
    expect(current).toEqual(["claude-fable-5-1", "claude-haiku-4-5", "claude-opus-5-5", "claude-sonnet-5"]);
  });

  it("still orders a built-in list sensibly with no catalog, by version within a family", () => {
    const { models } = buildModelList({
      live: [
        { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
        { id: "claude-opus-5", label: "Claude Opus 5" },
        { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      ],
      catalog: null,
      now: NOW,
    });
    expect(models.map((m) => [m.id, m.status])).toEqual([
      ["claude-opus-5", "current"],
      ["claude-sonnet-4-6", "current"],
      ["claude-opus-4-7", "legacy"],
    ]);
  });

  it("leaves models it cannot place in a family alone", () => {
    const { models } = buildModelList({ live: [{ id: "llama3.1:8b" }, { id: "mistral:7b" }], catalog: null, now: NOW });
    expect(models.every((m) => m.status === "current")).toBe(true);
    expect(models.map((m) => m.label)).toEqual(["llama3.1:8b", "mistral:7b"]);
  });
});

describe("buildModelList: things that are not text models, and OpenAI's own quirks", () => {
  const googleCatalog: ModelCatalog = {
    source: "test",
    fetchedAt: NOW.toISOString(),
    providers: {
      google: {
        "gemini-3.1-pro-preview": { id: "gemini-3.1-pro-preview", family: "gemini-pro", releaseDate: "2026-02-19", outputsText: true },
        "gemini-3-pro-image": { id: "gemini-3-pro-image", family: "gemini-pro", releaseDate: "2026-05-28", outputsText: false },
      },
      openai: {
        "gpt-5": { id: "gpt-5", family: "gpt", releaseDate: "2025-08-07", outputsText: true },
        "gpt-5.5": { id: "gpt-5.5", family: "gpt", releaseDate: "2026-04-23", outputsText: true },
      },
    },
  };

  it("leaves out image generators, so they never replace a text model", () => {
    const { models } = buildModelList({
      live: [{ id: "gemini-3.1-pro-preview" }, { id: "gemini-3-pro-image" }],
      catalog: googleCatalog,
      catalogProvider: "google",
      now: NOW,
    });
    expect(models.map((m) => [m.id, m.status])).toEqual([["gemini-3.1-pro-preview", "current"]]);
  });

  it("folds an OpenAI dated snapshot into its model and never reads the date as a version", () => {
    const { models } = buildModelList({
      live: [{ id: "gpt-5-2025-08-07" }, { id: "gpt-5" }, { id: "gpt-5.5" }],
      catalog: googleCatalog,
      catalogProvider: "openai",
      now: NOW,
    });
    expect(models.map((m) => [m.id, m.status])).toEqual([
      ["gpt-5.5", "current"],
      ["gpt-5", "legacy"],
    ]);
    expect(models[1].aliases).toContain("gpt-5-2025-08-07");
    expect(modelVersionParts("gpt-5-2025-08-07")).toEqual([5]);
  });

  it("never ranks an OpenAI -pro model (Responses only) above its base model", () => {
    const ranked = rankModelsForDefault([{ id: "gpt-5.5-pro" }, { id: "gpt-5.5" }]);
    expect(ranked[0].id).toBe("gpt-5.5");
  });
});

describe("versions and recency", () => {
  it("reads version numbers without the snapshot date or context suffix", () => {
    expect(modelVersionParts("claude-haiku-4-5-20251001")).toEqual([4, 5]);
    expect(modelVersionParts("claude-opus-5-5[1m]")).toEqual([5, 5]);
    expect(modelVersionParts("gpt-5.6-sol")).toEqual([5, 6]);
  });

  it("prefers release dates, then version numbers", () => {
    expect(compareModelRecency({ id: "a-1", releasedAt: "2026-09-22" }, { id: "a-9", releasedAt: "2026-01-01" })).toBeGreaterThan(0);
    expect(compareModelRecency({ id: "claude-opus-5-5" }, { id: "claude-opus-5" })).toBeGreaterThan(0);
    expect(compareModelRecency({ id: "claude-opus-4-8" }, { id: "claude-opus-5" })).toBeLessThan(0);
  });
});

describe("rankModelsForDefault", () => {
  it("prefers Opus, then Fable, then Sonnet, then Haiku, then GPT, then Gemini, then local models", () => {
    expect(modelFamilyTier("claude-opus-5-5")).toBeGreaterThan(modelFamilyTier("claude-fable-5-1"));
    expect(modelFamilyTier("claude-fable-5-1")).toBeGreaterThan(modelFamilyTier("claude-sonnet-5"));
    expect(modelFamilyTier("claude-sonnet-5")).toBeGreaterThan(modelFamilyTier("claude-haiku-4-5"));
    expect(modelFamilyTier("claude-haiku-4-5")).toBeGreaterThan(modelFamilyTier("gpt-6-astra"));
    expect(modelFamilyTier("gpt-6-astra")).toBeGreaterThan(modelFamilyTier("gemini-3.8-flash"));
    expect(modelFamilyTier("gemini-3.8-flash")).toBeGreaterThan(modelFamilyTier("llama3.1:8b"));
  });

  it("picks a model released today over the one before it, whatever the routing", () => {
    const ranked = rankModelsForDefault([
      { id: "claude-opus-5", provider: "adapter", source: "claude_local", status: "legacy" },
      { id: "claude-opus-5-5", provider: "anthropic", status: "current", releasedAt: "2026-09-22" },
      { id: "claude-opus-4-7", provider: "adapter", source: "claude_local" },
    ]);
    expect(ranked[0].id).toBe("claude-opus-5-5");
  });

  it("uses the provider's own default among equals before recency", () => {
    const ranked = rankModelsForDefault([
      { id: "gpt-6-sol", releasedAt: "2026-09-22" },
      { id: "gpt-6-astra", releasedAt: "2026-09-04", isDefault: true },
    ]);
    expect(ranked[0].id).toBe("gpt-6-astra");
  });

  it("breaks exact ties by routing: CLI adapters first, or native SDKs first when asked", () => {
    const models = [
      { id: "claude-opus-5-5", provider: "anthropic" },
      { id: "claude-opus-5-5", provider: "adapter", source: "claude_local" },
    ];
    expect(rankModelsForDefault(models)[0].provider).toBe("adapter");
    expect(rankModelsForDefault(models, { prefer: "native" })[0].provider).toBe("anthropic");
  });
});
