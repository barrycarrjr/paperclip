import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Isolate from any host ~/.paperclip config file.
let configFileValue: unknown = null;
vi.mock("../config-file.js", () => ({
  readConfigFile: () => configFileValue,
}));

import {
  fetchLiveClaudeModels,
  listClaudeModelsWithDiscovery,
  refreshClaudeModelsWithDiscovery,
  probeClaudeModels,
  resetClaudeModelsCacheForTests,
} from "../adapters/claude-models.js";

const ORIGINAL_ENV = { ...process.env };

function mockAnthropicApi(pages: Array<{ data: unknown[]; has_more?: boolean; last_id?: string }>) {
  let call = 0;
  return vi.fn(async () => {
    const page = pages[Math.min(call, pages.length - 1)];
    call += 1;
    return { ok: true, json: async () => page } as unknown as Response;
  });
}

describe("claude model discovery", () => {
  beforeEach(() => {
    resetClaudeModelsCacheForTests();
    configFileValue = null;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.ANTHROPIC_BEDROCK_BASE_URL;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns the curated list and null-live when there is no API key (subscription-only can't be discovered)", async () => {
    const models = await listClaudeModelsWithDiscovery();
    expect(models.length).toBeGreaterThan(0);
    expect(await fetchLiveClaudeModels()).toBeNull();
  });

  it("keeps the curated Bedrock list and never auto-discovers under Bedrock", async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    const models = await listClaudeModelsWithDiscovery();
    expect(models.some((m) => /^\w+\.anthropic\./.test(m.id))).toBe(true);
    expect(await fetchLiveClaudeModels()).toBeNull();
  });

  it("merges live API results with the curated list so active models not in this subscription still appear", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-abc123";
    vi.stubGlobal(
      "fetch",
      mockAnthropicApi([
        {
          data: [
            { type: "model", id: "claude-opus-4-8", display_name: "Claude Opus 4.8" },
            { type: "model", id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" },
          ],
        },
      ]),
    );
    const models = await refreshClaudeModelsWithDiscovery();
    // API-returned models appear with API-supplied labels.
    expect(models.some((m) => m.id === "claude-haiku-4-5" && m.label === "Claude Haiku 4.5")).toBe(true);
    expect(models.some((m) => m.id === "claude-opus-4-8" && m.label === "Claude Opus 4.8")).toBe(true);
    // Curated-only models are also present (active but not returned by this subscription's API key).
    expect(models.map((m) => m.id)).toContain("claude-opus-4-5");
    expect(models.map((m) => m.id)).toContain("claude-sonnet-4-5");
    // fetchLiveClaudeModels still returns only the raw API results (no curated merge).
    const live = await fetchLiveClaudeModels();
    expect(live?.map((m) => m.id)).toEqual(["claude-haiku-4-5", "claude-opus-4-8"]);
  });

  it("follows pagination via has_more/last_id", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-abc123";
    vi.stubGlobal(
      "fetch",
      mockAnthropicApi([
        { data: [{ id: "claude-a" }], has_more: true, last_id: "claude-a" },
        { data: [{ id: "claude-b" }], has_more: false },
      ]),
    );
    const live = await fetchLiveClaudeModels();
    expect(live?.map((m) => m.id)).toEqual(["claude-a", "claude-b"]);
  });

  it("falls back to the curated list (and null-live) when the API errors", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-abc123";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) }) as unknown as Response));
    expect(await fetchLiveClaudeModels()).toBeNull();
    const models = await listClaudeModelsWithDiscovery();
    expect(models.length).toBeGreaterThan(0);
  });

  it("reads the API key from the config file when the env var is absent", async () => {
    configFileValue = { llm: { provider: "claude", apiKey: "sk-ant-config-xyz789" } };
    vi.stubGlobal(
      "fetch",
      mockAnthropicApi([{ data: [{ id: "claude-from-config", display_name: "From Config" }] }]),
    );
    const live = await fetchLiveClaudeModels();
    expect(live?.map((m) => m.id)).toEqual(["claude-from-config"]);
  });

  it("probe returns only the models the runner approves (opt-in validation)", async () => {
    const candidates = [
      { id: "claude-opus-4-8", label: "Opus" },
      { id: "claude-retired-1", label: "Retired" },
      { id: "claude-haiku-4-5", label: "Haiku" },
    ];
    const runner = async (id: string) => id !== "claude-retired-1";
    const available = await probeClaudeModels({ candidates, runner });
    expect(available.map((m) => m.id)).toEqual(["claude-haiku-4-5", "claude-opus-4-8"]);
  });
});
