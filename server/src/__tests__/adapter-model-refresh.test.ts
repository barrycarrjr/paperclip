import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Candidate agent rows the fake db returns for the detection query.
let agentRows: Array<{ id: string; companyId: string; adapterType: string; adapterConfig: unknown }> = [];

const pauseMock = vi.fn(async (_id: string, _reason: string) => ({}));
const logActivityMock = vi.fn(async () => {});
const fetchLiveOllama = vi.fn<[], Promise<Array<{ id: string; label: string }> | null>>();
const fetchLiveAider = vi.fn<[], Promise<Array<{ id: string; label: string }> | null>>();
const fetchLiveGemini = vi.fn<[], Promise<Array<{ id: string; label: string }> | null>>();

vi.mock("../adapters/registry.js", () => ({ refreshAdapterModels: vi.fn(async () => []) }));
vi.mock("../adapters/ollama-models.js", () => ({
  fetchLiveOllamaModels: () => fetchLiveOllama(),
  fetchLiveAiderModels: () => fetchLiveAider(),
}));
vi.mock("../adapters/gemini-models.js", () => ({ fetchLiveGeminiModels: () => fetchLiveGemini() }));
vi.mock("../adapters/claude-models.js", () => ({
  listClaudeModelsWithDiscovery: async () => [],
  refreshClaudeModelsWithDiscovery: async () => [],
}));
vi.mock("../services/agents.js", () => ({ agentService: () => ({ pause: pauseMock }) }));
vi.mock("../services/activity-log.js", () => ({ logActivity: (...args: unknown[]) => logActivityMock(...args) }));

import { adapterModelRefreshService } from "../services/adapter-model-refresh.js";

const fakeDb = {
  select: () => ({ from: () => ({ where: async () => agentRows }) }),
} as never;

function model(m: string) {
  return { model: m };
}

describe("adapter model refresh: vanished-model detection", () => {
  beforeEach(() => {
    agentRows = [];
    pauseMock.mockClear();
    logActivityMock.mockClear();
    fetchLiveOllama.mockReset();
    fetchLiveAider.mockReset();
    fetchLiveGemini.mockReset();
    fetchLiveOllama.mockResolvedValue([{ id: "llama3.1:8b", label: "llama3.1:8b" }]);
    fetchLiveAider.mockResolvedValue([{ id: "ollama/llama3.1:8b", label: "x" }]);
    fetchLiveGemini.mockResolvedValue([{ id: "auto", label: "Auto" }, { id: "gemini-2.5-pro", label: "x" }]);
  });
  afterEach(() => vi.restoreAllMocks());

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
});
