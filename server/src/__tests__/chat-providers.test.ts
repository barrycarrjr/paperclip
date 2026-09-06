import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getProviderForModel,
  listAvailableModels,
  listConfiguredProviders,
  pickBestDefaultModel,
  encodeAdapterModel,
} from "../services/chat-providers.js";

const ENV_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OLLAMA_HOST", "PAPERCLIP_OLLAMA_ENABLED"];

describe("chat-providers", () => {
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      original[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  it("routes models by id prefix", () => {
    expect(getProviderForModel("claude-opus-4-7")?.name).toBe("anthropic");
    expect(getProviderForModel("gpt-4.1")?.name).toBe("openai");
    expect(getProviderForModel("gemini-2.0-flash")?.name).toBe("gemini");
    expect(getProviderForModel("llama3.2")?.name).toBe("ollama");
  });

  it("listConfiguredProviders excludes API-keyed providers when no keys are set, but includes always-on providers (ollama, adapter)", () => {
    const names = listConfiguredProviders().map((p) => p.name).sort();
    // No API-keyed providers configured
    expect(names).not.toContain("anthropic");
    expect(names).not.toContain("openai");
    expect(names).not.toContain("gemini");
    // Always-on: Ollama (auto-detect at default URL) and AdapterExecute
    expect(names).toContain("ollama");
    expect(names).toContain("adapter");
  });

  it("listConfiguredProviders includes a provider when its key is set", () => {
    process.env.GEMINI_API_KEY = "test-key";
    const configured = listConfiguredProviders().map((p) => p.name);
    expect(configured).toContain("gemini");
  });

  it("listAvailableModels returns no models when no providers are configured (and adapter discovery is best-effort)", async () => {
    const models = await listAvailableModels();
    // No native providers configured; adapter discovery may add some adapter-tagged models.
    // The contract: every entry has model + provider strings.
    for (const m of models) {
      expect(typeof m.model).toBe("string");
      expect(typeof m.provider).toBe("string");
    }
  });

  it("listAvailableModels includes Anthropic models when ANTHROPIC_API_KEY is set", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const models = await listAvailableModels();
    const claudeModels = models.filter((m) => m.provider === "anthropic");
    expect(claudeModels.length).toBeGreaterThan(0);
    expect(claudeModels.map((m) => m.model)).toContain("claude-opus-4-7");
  });
});

describe("pickBestDefaultModel", () => {
  const ENV = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OLLAMA_HOST", "PAPERCLIP_OLLAMA_DISABLED", "PAPERCLIP_CHAT_DEFAULT_MODEL"];
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV) {
      original[k] = process.env[k];
      delete process.env[k];
    }
    vi.resetModules();
  });
  afterEach(() => {
    for (const k of ENV) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
    vi.resetModules();
  });

  async function loadWithAdapters(adapterTypes: Array<{ type: string; modelIds: string[] }>) {
    vi.doMock("../adapters/registry.js", () => ({
      findActiveServerAdapter: (t: string) =>
        adapterTypes.find((a) => a.type === t) ? { type: t } : null,
      listEnabledServerAdapters: () =>
        adapterTypes.map((a) => ({ type: a.type, models: a.modelIds.map((id) => ({ id, label: id })) })),
      listAdapterModels: async (t: string) => {
        const a = adapterTypes.find((x) => x.type === t);
        return a ? a.modelIds.map((id) => ({ id, label: id })) : [];
      },
    }));
    return import("../services/chat-providers.js");
  }

  it("picks claude_local Opus over aider_local Ollama (regression)", async () => {
    process.env.PAPERCLIP_OLLAMA_DISABLED = "1";
    const mod = await loadWithAdapters([
      { type: "aider_local", modelIds: ["ollama/llama3.1:8b", "ollama/llama3.1:70b"] },
      { type: "claude_local", modelIds: ["claude-opus-4-7", "claude-sonnet-4-6"] },
      { type: "codex_local", modelIds: ["gpt-5"] },
    ]);
    const picked = await mod.pickBestDefaultModel();
    expect(picked).toBe(mod.encodeAdapterModel("claude_local", "claude-opus-4-7"));
  });

  it("picks codex_local gpt-5 when claude_local isn't available", async () => {
    process.env.PAPERCLIP_OLLAMA_DISABLED = "1";
    const mod = await loadWithAdapters([
      { type: "aider_local", modelIds: ["ollama/llama3.1:8b"] },
      { type: "codex_local", modelIds: ["gpt-5", "gpt-4.1"] },
    ]);
    const picked = await mod.pickBestDefaultModel();
    expect(picked).toBe(mod.encodeAdapterModel("codex_local", "gpt-5"));
  });

  it("respects PAPERCLIP_CHAT_DEFAULT_MODEL when its provider is configured", async () => {
    process.env.ANTHROPIC_API_KEY = "test";
    process.env.PAPERCLIP_CHAT_DEFAULT_MODEL = "claude-sonnet-4-6";
    const picked = await pickBestDefaultModel();
    expect(picked).toBe("claude-sonnet-4-6");
  });

  it("falls back to a hardcoded id when nothing is configured at all", async () => {
    process.env.PAPERCLIP_OLLAMA_DISABLED = "1";
    const mod = await loadWithAdapters([]);
    const picked = await mod.pickBestDefaultModel();
    expect(picked).toBe("claude-opus-4-7");
  });

  it("regression: when claude_local is disabled, prefers codex_local gpt-5 over aider_local llama", async () => {
    // Reproduces the reported setup: claude_local off, aider_local + codex_local on.
    // Prior to the model-family-first scoring, aider_local won (alphabetic
    // tiebreak among adapter:50 entries); now gpt-5 should win.
    process.env.PAPERCLIP_OLLAMA_DISABLED = "1";
    const mod = await loadWithAdapters([
      { type: "aider_local", modelIds: ["ollama/llama3.1:8b", "ollama/llama3.1:70b"] },
      { type: "codex_local", modelIds: ["gpt-5", "gpt-4.1"] },
    ]);
    const picked = await mod.pickBestDefaultModel();
    expect(picked).toBe(mod.encodeAdapterModel("codex_local", "gpt-5"));
  });

  it("regression: a Claude model from any source still wins over llama via aider", async () => {
    process.env.PAPERCLIP_OLLAMA_DISABLED = "1";
    const mod = await loadWithAdapters([
      { type: "aider_local", modelIds: ["ollama/llama3.1:8b"] },
      // Some hypothetical adapter exposes a Claude model under a non-recognized source name
      { type: "exotic_provider", modelIds: ["claude-opus-4-7"] },
    ]);
    const picked = await mod.pickBestDefaultModel();
    expect(picked).toBe(mod.encodeAdapterModel("exotic_provider", "claude-opus-4-7"));
  });
});

describe("pickOneShotModel", () => {
  const ENV = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OLLAMA_HOST", "PAPERCLIP_OLLAMA_DISABLED", "PAPERCLIP_CHAT_DEFAULT_MODEL"];
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV) {
      original[k] = process.env[k];
      delete process.env[k];
    }
    vi.resetModules();
  });
  afterEach(() => {
    for (const k of ENV) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function loadWithAdapters(adapterTypes: Array<{ type: string; modelIds: string[] }>) {
    vi.doMock("../adapters/registry.js", () => ({
      findActiveServerAdapter: (t: string) =>
        adapterTypes.find((a) => a.type === t) ? { type: t } : null,
      listEnabledServerAdapters: () =>
        adapterTypes.map((a) => ({ type: a.type, models: a.modelIds.map((id) => ({ id, label: id })) })),
      listAdapterModels: async (t: string) => {
        const a = adapterTypes.find((x) => x.type === t);
        return a ? a.modelIds.map((id) => ({ id, label: id })) : [];
      },
    }));
    return import("../services/chat-providers.js");
  }

  it("pickOneShotModel prefers a configured native provider over adapters and Ollama", async () => {
    // Ollama is left enabled on purpose: a native key must win without the
    // cascade ever probing Ollama, so the fetch spy doubles as the proof.
    process.env.ANTHROPIC_API_KEY = "test";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const mod = await loadWithAdapters([
      { type: "claude_local", modelIds: ["claude-opus-4-7", "claude-sonnet-4-6"] },
      { type: "codex_local", modelIds: ["gpt-5"] },
    ]);
    const picked = await mod.pickOneShotModel();
    expect(picked).toBe("claude-opus-4-7");
    expect(picked).not.toBe(mod.encodeAdapterModel("claude_local", "claude-opus-4-7"));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("pickOneShotModel walks the native order anthropic, openai, gemini", async () => {
    process.env.PAPERCLIP_OLLAMA_DISABLED = "1";
    process.env.OPENAI_API_KEY = "test";
    process.env.GEMINI_API_KEY = "test";
    let mod = await loadWithAdapters([]);
    expect(await mod.pickOneShotModel()).toBe("gpt-4.1");

    delete process.env.OPENAI_API_KEY;
    vi.resetModules();
    mod = await loadWithAdapters([]);
    expect(await mod.pickOneShotModel()).toBe("gemini-2.0-flash");
  });

  it("pickOneShotModel falls through to the best discovered adapter model when nothing native is configured", async () => {
    process.env.PAPERCLIP_OLLAMA_DISABLED = "1";
    const mod = await loadWithAdapters([
      { type: "aider_local", modelIds: ["ollama/llama3.1:8b"] },
      { type: "claude_local", modelIds: ["claude-opus-4-7", "claude-sonnet-4-6"] },
    ]);
    const picked = await mod.pickOneShotModel();
    // Same ranking as pickBestDefaultModel: the two must never disagree.
    expect(picked).toBe(mod.encodeAdapterModel("claude_local", "claude-opus-4-7"));
    expect(picked).toBe(await mod.pickBestDefaultModel());
  });

  it("pickOneShotModel returns null when no provider is configured and no adapter model is discovered, never claude-opus-4-7", async () => {
    process.env.PAPERCLIP_OLLAMA_DISABLED = "1";
    const mod = await loadWithAdapters([]);
    const picked = await mod.pickOneShotModel();
    expect(picked).toBeNull();
    // The sibling helper keeps its hardcoded fallback; this one must not.
    expect(await mod.pickBestDefaultModel()).toBe("claude-opus-4-7");
  });

  it("pickOneShotModel honours PAPERCLIP_CHAT_DEFAULT_MODEL when no native provider is configured", async () => {
    process.env.PAPERCLIP_OLLAMA_DISABLED = "1";
    const mod = await loadWithAdapters([
      { type: "claude_local", modelIds: ["claude-opus-4-7", "claude-sonnet-4-6"] },
    ]);
    // Sonnet on purpose: discovery would rank opus first, so picking sonnet
    // can only be the explicit choice being honoured.
    const explicit = mod.encodeAdapterModel("claude_local", "claude-sonnet-4-6");
    process.env.PAPERCLIP_CHAT_DEFAULT_MODEL = explicit;
    expect(await mod.pickOneShotModel()).toBe(explicit);
  });

  it("pickOneShotModel prefers the native default over a serveable PAPERCLIP_CHAT_DEFAULT_MODEL", async () => {
    process.env.PAPERCLIP_OLLAMA_DISABLED = "1";
    process.env.ANTHROPIC_API_KEY = "test";
    // OpenAI has a key too, so gpt-4.1 really could be served. The native
    // order still wins: this is the ai-rewrite behaviour from before the
    // cascade moved into this helper, where a native SDK call costs
    // hundreds of milliseconds and an adapter or second hop costs seconds.
    process.env.OPENAI_API_KEY = "test";
    process.env.PAPERCLIP_CHAT_DEFAULT_MODEL = "gpt-4.1";
    const mod = await loadWithAdapters([]);
    expect(await mod.pickOneShotModel()).toBe("claude-opus-4-7");
  });

  it("pickOneShotModel ignores an explicit choice whose provider has no key and falls through to discovery", async () => {
    process.env.PAPERCLIP_OLLAMA_DISABLED = "1";
    // gpt-4.1 with no OPENAI_API_KEY and no native provider at all.
    process.env.PAPERCLIP_CHAT_DEFAULT_MODEL = "gpt-4.1";
    const mod = await loadWithAdapters([
      { type: "claude_local", modelIds: ["claude-opus-4-7", "claude-sonnet-4-6"] },
    ]);
    expect(await mod.pickOneShotModel()).toBe(mod.encodeAdapterModel("claude_local", "claude-opus-4-7"));
  });
});
