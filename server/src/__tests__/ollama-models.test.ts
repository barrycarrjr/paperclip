import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Controls the fake Ollama `/api/tags` transport for each test.
let pulled: string[] | null = [];

vi.mock("@paperclipai/adapter-ollama-local/server", () => ({
  listPulledOllamaModels: async () => pulled,
}));

import {
  fetchLiveOllamaModels,
  fetchLiveAiderModels,
  listOllamaModels,
  refreshOllamaModels,
  listAiderModels,
  resetOllamaModelsCacheForTests,
} from "../adapters/ollama-models.js";

describe("ollama/aider model discovery", () => {
  beforeEach(() => {
    pulled = [];
    resetOllamaModelsCacheForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps pulled models to sorted {id,label} and does not merge the curated fallback (retired models drop off)", async () => {
    pulled = ["qwen2.5-coder:7b", "llama3.1:8b"];
    const models = await listOllamaModels();
    expect(models).toEqual([
      { id: "llama3.1:8b", label: "llama3.1:8b" },
      { id: "qwen2.5-coder:7b", label: "qwen2.5-coder:7b" },
    ]);
    // None of the curated defaults (e.g. mistral:7b, phi3:mini) leak in.
    expect(models.some((m) => m.id === "mistral:7b")).toBe(false);
  });

  it("aider_local prefixes ids with ollama/ and labels them", async () => {
    pulled = ["llama3.1:8b"];
    const models = await listAiderModels();
    expect(models).toEqual([{ id: "ollama/llama3.1:8b", label: "Ollama · llama3.1:8b" }]);
  });

  it("fetchLive* returns null when Ollama is unreachable, a list otherwise", async () => {
    pulled = null;
    expect(await fetchLiveOllamaModels()).toBeNull();
    expect(await fetchLiveAiderModels()).toBeNull();
    pulled = ["llama3.1:8b"];
    expect(await fetchLiveOllamaModels()).toEqual([{ id: "llama3.1:8b", label: "llama3.1:8b" }]);
  });

  it("serves the curated fallback (not an empty menu) when Ollama is unreachable and nothing is cached", async () => {
    pulled = null;
    const models = await listOllamaModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.id === "llama3.1:8b")).toBe(true);
  });

  it("serves last-known models over the fallback when a later fetch fails", async () => {
    pulled = ["custom-model:latest"];
    const first = await refreshOllamaModels();
    expect(first).toEqual([{ id: "custom-model:latest", label: "custom-model:latest" }]);

    // Ollama goes away; a cached list must be preferred over the curated fallback.
    pulled = null;
    const cached = await listOllamaModels();
    expect(cached).toEqual([{ id: "custom-model:latest", label: "custom-model:latest" }]);
  });

  it("refresh bypasses the TTL cache and reflects newly pulled models", async () => {
    pulled = ["llama3.1:8b"];
    await listOllamaModels();
    pulled = ["llama3.1:8b", "gemma3:12b"];
    // list() would still return the cached single model within the TTL...
    expect(await listOllamaModels()).toHaveLength(1);
    // ...refresh() re-reads the live source.
    const refreshed = await refreshOllamaModels();
    expect(refreshed.map((m) => m.id)).toEqual(["gemma3:12b", "llama3.1:8b"]);
  });
});
