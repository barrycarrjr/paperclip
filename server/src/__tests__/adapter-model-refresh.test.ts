import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterModel } from "../adapters/types.js";
import type { ModelAvailabilityState } from "../services/model-availability-state.js";
import { emptyModelAvailabilityState } from "../services/model-availability-state.js";

// Candidate agent rows the fake db returns for the detection query.
let agentRows: Array<{ id: string; companyId: string; adapterType: string; adapterConfig: unknown }> = [];

const pauseMock = vi.fn(async (_id: string, _reason: string) => ({}));
const logActivityMock = vi.fn(async (..._args: unknown[]) => {});
const fetchLiveOllama = vi.fn<[], Promise<Array<{ id: string; label: string }> | null>>();
const fetchLiveAider = vi.fn<[], Promise<Array<{ id: string; label: string }> | null>>();
const fetchLiveGemini = vi.fn<[], Promise<Array<{ id: string; label: string }> | null>>();
const fetchLiveCodex = vi.fn<[], Promise<Array<{ id: string; label: string }> | null>>();
const claudeAvailability = vi.fn<[], Promise<{ source: string; models: AdapterModel[] }>>();
const codexAvailability = vi.fn<[], Promise<{ source: string; models: AdapterModel[] }>>();
const refreshCatalog = vi.fn(async () => null);

vi.mock("../adapters/registry.js", () => ({
  refreshAdapterModels: vi.fn(async () => []),
  listAdapterModels: vi.fn(async () => []),
}));
vi.mock("../adapters/ollama-models.js", () => ({
  fetchLiveOllamaModels: () => fetchLiveOllama(),
  fetchLiveAiderModels: () => fetchLiveAider(),
}));
vi.mock("../adapters/gemini-models.js", () => ({ fetchLiveGeminiModels: () => fetchLiveGemini() }));
vi.mock("../adapters/codex-models.js", () => ({
  fetchLiveCodexModels: () => fetchLiveCodex(),
  getCodexModelAvailability: () => codexAvailability(),
}));
vi.mock("../adapters/claude-models.js", () => ({
  getClaudeModelAvailability: () => claudeAvailability(),
  listClaudeModelsWithDiscovery: async () => [],
  refreshClaudeModelsWithDiscovery: async () => [],
}));
vi.mock("../services/model-catalog.js", () => ({ refreshModelCatalog: () => refreshCatalog() }));
vi.mock("../services/agents.js", () => ({ agentService: () => ({ pause: pauseMock }) }));
vi.mock("../services/activity-log.js", () => ({ logActivity: (...args: unknown[]) => logActivityMock(...args) }));

import { adapterModelRefreshService } from "../services/adapter-model-refresh.js";

const fakeDb = {
  select: () => ({ from: () => ({ where: async () => agentRows }) }),
} as never;

function model(m: string) {
  return { model: m };
}

function memoryStore(initial: ModelAvailabilityState = emptyModelAvailabilityState()) {
  let saved = initial;
  return {
    store: {
      read: async () => structuredClone(saved),
      write: async (state: ModelAvailabilityState) => {
        saved = structuredClone(state);
      },
    },
    get saved() {
      return saved;
    },
  };
}

function actions(): string[] {
  return logActivityMock.mock.calls.map((call) => (call[1] as { action: string }).action);
}

function activity(index: number) {
  return logActivityMock.mock.calls[index][1] as {
    companyId: string;
    action: string;
    entityId: string;
    details: Record<string, unknown>;
  };
}

const CLAUDE_TODAY: AdapterModel[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", status: "current", isDefault: true, aliases: ["opus"] },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", status: "current" },
  { id: "claude-opus-5", label: "Claude Opus 5", status: "legacy", replacementId: "claude-opus-5-5" },
];

const CODEX_TODAY: AdapterModel[] = [
  { id: "gpt-6-astra", label: "GPT-6-Astra", status: "current", isDefault: true },
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    status: "deprecated",
    retiresAt: "2026-10-14T19:00:00.000Z",
    replacementId: "gpt-6-astra",
    notice: "GPT-5.5 retires on October 14, 2026.",
  },
];

beforeEach(() => {
  agentRows = [];
  pauseMock.mockClear();
  logActivityMock.mockClear();
  refreshCatalog.mockClear();
  fetchLiveOllama.mockReset();
  fetchLiveAider.mockReset();
  fetchLiveGemini.mockReset();
  fetchLiveCodex.mockReset();
  claudeAvailability.mockReset();
  codexAvailability.mockReset();
  fetchLiveOllama.mockResolvedValue([{ id: "llama3.1:8b", label: "llama3.1:8b" }]);
  fetchLiveAider.mockResolvedValue([{ id: "ollama/llama3.1:8b", label: "x" }]);
  fetchLiveGemini.mockResolvedValue([{ id: "auto", label: "Auto" }, { id: "gemini-2.5-pro", label: "x" }]);
  fetchLiveCodex.mockResolvedValue([
    { id: "gpt-6-astra", label: "gpt-6-astra" },
    { id: "gpt-5.5", label: "gpt-5.5" },
    { id: "gpt-reserve", label: "gpt-reserve" },
  ]);
  claudeAvailability.mockResolvedValue({ source: "cli", models: CLAUDE_TODAY });
  codexAvailability.mockResolvedValue({ source: "codex", models: CODEX_TODAY });
});
afterEach(() => vi.restoreAllMocks());

describe("adapter model refresh: vanished-model detection", () => {
  it("does not pause an agent whose model is still available", async () => {
    agentRows = [{ id: "a1", companyId: "c1", adapterType: "ollama_local", adapterConfig: model("llama3.1:8b") }];
    const { paused } = await adapterModelRefreshService(fakeDb).detectVanishedModels();
    expect(paused).toEqual([]);
    expect(pauseMock).not.toHaveBeenCalled();
  });

  it("pauses and flags an agent whose model is gone from the live list", async () => {
    agentRows = [{ id: "a1", companyId: "c1", adapterType: "ollama_local", adapterConfig: model("mistral:7b") }];
    const { paused } = await adapterModelRefreshService(fakeDb).detectVanishedModels();
    expect(paused).toEqual([{ agentId: "a1", companyId: "c1", adapterType: "ollama_local", model: "mistral:7b" }]);
    expect(pauseMock).toHaveBeenCalledWith("a1", "system");
    expect(logActivityMock).toHaveBeenCalledTimes(1);
    const details = (logActivityMock.mock.calls[0][1] as { action: string; details: { model: string } });
    expect(details.action).toBe("agent.model_unavailable");
    expect(details.details.model).toBe("mistral:7b");
  });

  it("NEVER pauses when the provider is unreachable (null live list), no false alarms during an outage", async () => {
    fetchLiveOllama.mockResolvedValue(null); // Ollama down
    agentRows = [{ id: "a1", companyId: "c1", adapterType: "ollama_local", adapterConfig: model("anything:latest") }];
    const { paused, indeterminate } = await adapterModelRefreshService(fakeDb).detectVanishedModels();
    expect(paused).toEqual([]);
    expect(pauseMock).not.toHaveBeenCalled();
    expect(indeterminate).toContain("ollama_local");
  });

  it("ignores agents with no explicit model (they use the adapter default)", async () => {
    agentRows = [{ id: "a1", companyId: "c1", adapterType: "ollama_local", adapterConfig: {} }];
    const { paused } = await adapterModelRefreshService(fakeDb).detectVanishedModels();
    expect(paused).toEqual([]);
    expect(pauseMock).not.toHaveBeenCalled();
  });

  it("treats Gemini's 'auto' as always valid but flags a retired concrete Gemini model", async () => {
    agentRows = [
      { id: "auto1", companyId: "c1", adapterType: "gemini_local", adapterConfig: model("auto") },
      { id: "old1", companyId: "c1", adapterType: "gemini_local", adapterConfig: model("gemini-1.0-pro") },
    ];
    const { paused } = await adapterModelRefreshService(fakeDb).detectVanishedModels();
    expect(paused.map((p) => p.agentId)).toEqual(["old1"]);
  });

  it("resolves each adapter's live list only once even with several agents", async () => {
    agentRows = [
      { id: "a1", companyId: "c1", adapterType: "ollama_local", adapterConfig: model("llama3.1:8b") },
      { id: "a2", companyId: "c1", adapterType: "ollama_local", adapterConfig: model("gone:1") },
      { id: "a3", companyId: "c2", adapterType: "aider_local", adapterConfig: model("ollama/llama3.1:8b") },
    ];
    const { paused } = await adapterModelRefreshService(fakeDb).detectVanishedModels();
    expect(fetchLiveOllama).toHaveBeenCalledTimes(1);
    expect(fetchLiveAider).toHaveBeenCalledTimes(1);
    expect(paused.map((p) => p.agentId)).toEqual(["a2"]);
  });

  it("pauses a Codex agent whose model Codex no longer accepts, and keeps one on a hidden but valid model", async () => {
    agentRows = [
      { id: "gone", companyId: "c1", adapterType: "codex_local", adapterConfig: model("gpt-5.3-codex") },
      { id: "hidden", companyId: "c1", adapterType: "codex_local", adapterConfig: model("gpt-reserve") },
      { id: "fine", companyId: "c1", adapterType: "codex_local", adapterConfig: model("gpt-6-astra") },
    ];
    const { paused } = await adapterModelRefreshService(fakeDb).detectVanishedModels();
    expect(paused.map((p) => p.agentId)).toEqual(["gone"]);
  });

  it("never pauses a Codex agent that signs in its own way, since the check used a different account", async () => {
    agentRows = [
      { id: "own-key", companyId: "c1", adapterType: "codex_local", adapterConfig: { model: "gpt-5.3-codex", env: { OPENAI_API_KEY: "sk-own" } } },
      { id: "own-home", companyId: "c1", adapterType: "codex_local", adapterConfig: { model: "gpt-5.3-codex", env: { CODEX_HOME: "/other" } } },
      { id: "own-binary", companyId: "c1", adapterType: "codex_local", adapterConfig: { model: "gpt-5.3-codex", command: "/opt/codex-beta" } },
    ];
    const { paused } = await adapterModelRefreshService(fakeDb).detectVanishedModels();
    expect(paused).toEqual([]);
  });

  it("never checks Claude agents for pausing, because the Claude CLI lists current models only", async () => {
    agentRows = [{ id: "c1", companyId: "c1", adapterType: "claude_local", adapterConfig: model("claude-opus-4-1") }];
    const { paused } = await adapterModelRefreshService(fakeDb).detectVanishedModels();
    expect(paused).toEqual([]);
  });
});

describe("adapter model refresh: telling people what changed", () => {
  it("records a baseline on the first check without announcing anything", async () => {
    const memory = memoryStore();
    agentRows = [{ id: "a1", companyId: "c1", adapterType: "claude_local", adapterConfig: model("claude-sonnet-5") }];
    const { announced } = await adapterModelRefreshService(fakeDb, { stateStore: memory.store }).noteModelChanges();
    expect(announced).toEqual([]);
    expect(actions()).not.toContain("model.available");
    expect(Object.keys(memory.saved.adapters.claude_local.models)).toEqual(
      expect.arrayContaining(["claude-opus-5-5", "claude-sonnet-5", "claude-opus-5"]),
    );
  });

  it("announces a model that appeared since the last check, to each company with agents on that adapter", async () => {
    const memory = memoryStore();
    agentRows = [
      { id: "a1", companyId: "c1", adapterType: "claude_local", adapterConfig: model("claude-opus-5-5") },
      { id: "a2", companyId: "c2", adapterType: "claude_local", adapterConfig: model("claude-opus-5-5") },
    ];
    const service = adapterModelRefreshService(fakeDb, { stateStore: memory.store });
    claudeAvailability.mockResolvedValue({ source: "cli", models: CLAUDE_TODAY.filter((m) => m.id !== "claude-sonnet-5") });
    await service.noteModelChanges();
    logActivityMock.mockClear();

    claudeAvailability.mockResolvedValue({ source: "cli", models: CLAUDE_TODAY });
    const { announced } = await service.noteModelChanges();
    expect(announced).toEqual([
      { adapterType: "claude_local", model: "claude-sonnet-5", label: "Claude Sonnet 5", companyIds: ["c1", "c2"] },
    ]);
    const logged = logActivityMock.mock.calls.map((call) => call[1] as { companyId: string; action: string; details: { model: string } });
    expect(logged.filter((l) => l.action === "model.available").map((l) => [l.companyId, l.details.model])).toEqual([
      ["c1", "claude-sonnet-5"],
      ["c2", "claude-sonnet-5"],
    ]);
  });

  it("never announces from a built-in fallback list", async () => {
    const memory = memoryStore();
    const service = adapterModelRefreshService(fakeDb, { stateStore: memory.store });
    claudeAvailability.mockResolvedValue({ source: "curated", models: [] });
    codexAvailability.mockResolvedValue({ source: "curated", models: CODEX_TODAY });
    fetchLiveGemini.mockResolvedValue(null);
    await service.noteModelChanges();
    expect(memory.saved.adapters).toEqual({});
  });

  it("tells an agent once that its model was replaced, with the successor, and not again the next day", async () => {
    const memory = memoryStore();
    agentRows = [{ id: "a1", companyId: "c1", adapterType: "claude_local", adapterConfig: model("claude-opus-5") }];
    const service = adapterModelRefreshService(fakeDb, { stateStore: memory.store });
    const first = await service.noteModelChanges();
    expect(first.flagged).toEqual([
      { agentId: "a1", companyId: "c1", adapterType: "claude_local", model: "claude-opus-5", state: "legacy", replacement: "claude-opus-5-5" },
    ]);
    const notice = activity(actions().indexOf("agent.model_needs_update"));
    expect(notice.entityId).toBe("a1");
    expect(notice.details).toMatchObject({
      model: "claude-opus-5",
      state: "legacy",
      replacementModel: "claude-opus-5-5",
      replacementLabel: "Claude Opus 5.5",
    });
    expect(String(notice.details.reason)).toContain("Consider switching to Claude Opus 5.5");

    logActivityMock.mockClear();
    const second = await service.noteModelChanges();
    expect(second.flagged).toEqual([]);
    expect(actions()).not.toContain("agent.model_needs_update");
  });

  it("tells an agent about a retirement with the provider's date and notice", async () => {
    const memory = memoryStore();
    agentRows = [{ id: "x1", companyId: "c1", adapterType: "codex_local", adapterConfig: model("gpt-5.5") }];
    await adapterModelRefreshService(fakeDb, { stateStore: memory.store }).noteModelChanges();
    const notice = activity(actions().indexOf("agent.model_needs_update"));
    expect(notice.details).toMatchObject({
      state: "retiring",
      retiresAt: "2026-10-14T19:00:00.000Z",
      notice: "GPT-5.5 retires on October 14, 2026.",
      replacementModel: "gpt-6-astra",
    });
    expect(String(notice.details.reason)).toContain("retiring on 2026-10-14");
  });

  it("flags, but never pauses, a Claude agent on a model the CLI and catalog do not list", async () => {
    const memory = memoryStore();
    agentRows = [{ id: "a1", companyId: "c1", adapterType: "claude_local", adapterConfig: model("claude-opus-4-1") }];
    const { flagged } = await adapterModelRefreshService(fakeDb, { stateStore: memory.store }).noteModelChanges();
    expect(flagged[0]).toMatchObject({ state: "unavailable", replacement: "claude-opus-5-5" });
    expect(pauseMock).not.toHaveBeenCalled();
  });

  it("does not call a hidden Codex model unlisted, since Codex accepts it", async () => {
    const memory = memoryStore();
    codexAvailability.mockResolvedValue({ source: "codex", models: CODEX_TODAY, allIds: ["gpt-6-astra", "gpt-5.5", "gpt-reserve"] } as never);
    agentRows = [{ id: "h1", companyId: "c1", adapterType: "codex_local", adapterConfig: model("gpt-reserve") }];
    const { flagged } = await adapterModelRefreshService(fakeDb, { stateStore: memory.store }).noteModelChanges();
    expect(flagged).toEqual([]);
  });

  it("does not call a Claude alias unlisted when the list came from the API, which has no aliases", async () => {
    const memory = memoryStore();
    claudeAvailability.mockResolvedValue({
      source: "api",
      models: CLAUDE_TODAY.map(({ aliases: _aliases, ...m }) => m),
    });
    agentRows = [{ id: "a1", companyId: "c1", adapterType: "claude_local", adapterConfig: model("sonnet") }];
    const { flagged } = await adapterModelRefreshService(fakeDb, { stateStore: memory.store }).noteModelChanges();
    expect(flagged).toEqual([]);
  });

  it("does not call a model unlisted for an agent with its own sign-in, but still tells it about a retirement", async () => {
    const memory = memoryStore();
    agentRows = [
      { id: "own", companyId: "c1", adapterType: "codex_local", adapterConfig: { model: "gpt-9-secret", env: { OPENAI_API_KEY: "sk" } } },
      { id: "own-retiring", companyId: "c1", adapterType: "codex_local", adapterConfig: { model: "gpt-5.5", env: { OPENAI_API_KEY: "sk" } } },
    ];
    const { flagged } = await adapterModelRefreshService(fakeDb, { stateStore: memory.store }).noteModelChanges();
    expect(flagged.map((f) => [f.agentId, f.state])).toEqual([["own-retiring", "retiring"]]);
  });

  it("does not flag agents on current models, aliases, or the adapter default, and clears an old notice", async () => {
    const memory = memoryStore({
      version: 1,
      adapters: {},
      agentNotices: { a3: { key: "claude-opus-5|legacy", notedAt: "2026-09-01T00:00:00Z" } },
    });
    agentRows = [
      { id: "a1", companyId: "c1", adapterType: "claude_local", adapterConfig: model("opus") },
      { id: "a2", companyId: "c1", adapterType: "claude_local", adapterConfig: {} },
      { id: "a3", companyId: "c1", adapterType: "claude_local", adapterConfig: model("claude-opus-5-5[1m]") },
    ];
    const { flagged } = await adapterModelRefreshService(fakeDb, { stateStore: memory.store }).noteModelChanges();
    expect(flagged).toEqual([]);
    expect(memory.saved.agentNotices).toEqual({});
  });

  it("the daily run refreshes the catalog first and skips agents it just paused", async () => {
    agentRows = [{ id: "gone", companyId: "c1", adapterType: "codex_local", adapterConfig: model("gpt-5.3-codex") }];
    const memory = memoryStore();
    const result = await adapterModelRefreshService(fakeDb, { stateStore: memory.store }).runDailyRefresh();
    expect(refreshCatalog).toHaveBeenCalledTimes(1);
    expect(result.paused.map((p) => p.agentId)).toEqual(["gone"]);
    expect(result.flagged).toEqual([]);
  });
});
