import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalog } from "../services/model-catalog.js";

const state = vi.hoisted(() => ({
  configFileValue: null as unknown,
  catalog: null as ModelCatalog | null,
  accountEnv: null as Record<string, string> | null,
  cliRows: null as Array<Record<string, unknown>> | null,
  cliError: null as Error | null,
  cliCalls: [] as Array<Record<string, string> | undefined>,
}));

// Isolate from any host ~/.paperclip config file.
vi.mock("../config-file.js", () => ({
  readConfigFile: () => state.configFileValue,
}));

vi.mock("../services/model-catalog.js", () => ({
  getModelCatalog: async () => state.catalog,
  refreshModelCatalog: async () => state.catalog,
  peekModelCatalog: () => state.catalog,
  lookupCatalogModel: (catalog: ModelCatalog | null, provider: string, id: string) =>
    catalog?.providers[provider]?.[id] ?? null,
}));

vi.mock("../services/active-account.js", () => ({
  resolveAdapterAccountEnv: async () => (state.accountEnv ? { env: state.accountEnv } : null),
}));

vi.mock("@paperclipai/adapter-claude-local/server", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-claude-local/server")>(
    "@paperclipai/adapter-claude-local/server",
  );
  return {
    ...actual,
    readClaudeCliModels: async (opts: { env?: Record<string, string> } = {}) => {
      state.cliCalls.push(opts.env);
      if (state.cliError) throw state.cliError;
      return { rows: actual.parseClaudeCliModelRows(state.cliRows ?? []), account: null };
    },
  };
});

import {
  fetchLiveClaudeModels,
  getClaudeModelAvailability,
  listClaudeModelsWithDiscovery,
  refreshClaudeModelsWithDiscovery,
  probeClaudeModels,
  resetClaudeModelsCacheForTests,
} from "../adapters/claude-models.js";

const ORIGINAL_ENV = { ...process.env };

// The CLI's initialize reply on a Max account, 2026-09-23.
const CLI_ROWS = [
  { value: "default", resolvedModel: "claude-opus-5-5[1m]", displayName: "Default (recommended)", supportedEffortLevels: ["low", "high"] },
  { value: "opus[1m]", resolvedModel: "claude-opus-5-5[1m]", displayName: "Opus (1M context)" },
  { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1", displayName: "Fable" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet" },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku" },
];

const CATALOG: ModelCatalog = {
  source: "test",
  fetchedAt: "2026-09-23T00:00:00Z",
  providers: {
    anthropic: {
      "claude-opus-5-5": { id: "claude-opus-5-5", name: "Claude Opus 5.5", family: "claude-opus", releaseDate: "2026-09-22" },
      "claude-fable-5-1": { id: "claude-fable-5-1", family: "claude-fable", releaseDate: "2026-09-01" },
      "claude-opus-5": { id: "claude-opus-5", name: "Claude Opus 5", family: "claude-opus", releaseDate: "2026-07-24" },
      "claude-sonnet-5": { id: "claude-sonnet-5", family: "claude-sonnet", releaseDate: "2026-06-29" },
      "claude-sonnet-4-6": { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", family: "claude-sonnet", releaseDate: "2026-02-17" },
      "claude-haiku-4-5": { id: "claude-haiku-4-5", family: "claude-haiku", releaseDate: "2025-10-15" },
    },
  },
};

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
    state.configFileValue = null;
    state.catalog = null;
    state.accountEnv = null;
    state.cliRows = CLI_ROWS;
    state.cliError = null;
    state.cliCalls = [];
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.ANTHROPIC_BEDROCK_BASE_URL;
    process.env.PAPERCLIP_MODEL_CLI_DISCOVERY = "on";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
  });

  it("lists what the Claude Code CLI offers the account, one entry per model, default first", async () => {
    const availability = await getClaudeModelAvailability();
    expect(availability.source).toBe("cli");
    expect(availability.exhaustive).toBe(false);
    expect(availability.models.map((m) => m.id)).toEqual([
      "claude-opus-5-5",
      "claude-fable-5-1",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ]);
    const opus = availability.models[0];
    expect(opus).toMatchObject({ label: "Claude Opus 5.5", isDefault: true, status: "current" });
    expect(opus.aliases).toEqual(expect.arrayContaining(["opus", "opus[1m]", "claude-opus-5-5[1m]"]));
    expect(availability.models[3].aliases).toEqual(expect.arrayContaining(["haiku", "claude-haiku-4-5-20251001"]));
  });

  it("adds the older models the CLI still runs from the catalog, marked legacy", async () => {
    state.catalog = CATALOG;
    const models = await listClaudeModelsWithDiscovery();
    const legacy = models.filter((m) => m.status === "legacy").map((m) => m.id);
    expect(legacy).toEqual(["claude-opus-5", "claude-sonnet-4-6"]);
    expect(models.find((m) => m.id === "claude-opus-5")?.replacementId).toBe("claude-opus-5-5");
    expect(models.find((m) => m.id === "claude-opus-5-5")?.releasedAt).toBe("2026-09-22");
  });

  it("asks the CLI as the account runs use, so the list matches that account", async () => {
    state.accountEnv = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-account-two" };
    await listClaudeModelsWithDiscovery();
    expect(state.cliCalls).toEqual([{ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-account-two" }]);
  });

  it("reuses a list for half an hour, and asks again on refresh", async () => {
    await listClaudeModelsWithDiscovery();
    await listClaudeModelsWithDiscovery();
    expect(state.cliCalls).toHaveLength(1);
    await refreshClaudeModelsWithDiscovery();
    expect(state.cliCalls).toHaveLength(2);
  });

  it("asks again when the account changes", async () => {
    await listClaudeModelsWithDiscovery();
    state.accountEnv = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-other-account" };
    await listClaudeModelsWithDiscovery();
    expect(state.cliCalls).toHaveLength(2);
  });

  it("falls back to the catalog when the CLI cannot be asked, keeping the reason", async () => {
    state.cliError = new Error("Command not found in PATH: \"claude\"");
    state.catalog = CATALOG;
    const availability = await getClaudeModelAvailability();
    expect(availability.source).toBe("catalog");
    expect(availability.cliError).toContain("not found");
    expect(availability.models.filter((m) => m.status === "current").map((m) => m.id).sort()).toEqual([
      "claude-fable-5-1",
      "claude-haiku-4-5",
      "claude-opus-5-5",
      "claude-sonnet-5",
    ]);
  });

  it("falls back to the built-in list with neither the CLI nor the catalog, newest current", async () => {
    state.cliError = new Error("timed out");
    const availability = await getClaudeModelAvailability();
    expect(availability.source).toBe("curated");
    expect(availability.models[0]).toMatchObject({ id: "claude-opus-5-5", status: "current" });
    expect(availability.models.find((m) => m.id === "claude-opus-4-7")?.status).toBe("legacy");
  });

  it("never spawns the CLI when discovery is switched off", async () => {
    process.env.PAPERCLIP_MODEL_CLI_DISCOVERY = "off";
    const availability = await getClaudeModelAvailability();
    expect(state.cliCalls).toHaveLength(0);
    expect(availability.source).toBe("curated");
  });

  it("keeps the curated Bedrock list and never auto-discovers under Bedrock", async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    const models = await listClaudeModelsWithDiscovery();
    expect(models.some((m) => /^\w+\.anthropic\./.test(m.id))).toBe(true);
    expect(await fetchLiveClaudeModels()).toBeNull();
    expect(state.cliCalls).toHaveLength(0);
  });

  it("with an API key, adds the key's complete list to the CLI's and counts as exhaustive", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-abc123";
    state.catalog = CATALOG;
    vi.stubGlobal(
      "fetch",
      mockAnthropicApi([
        {
          data: [
            { type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5" },
            { type: "model", id: "claude-opus-5", display_name: "Claude Opus 5" },
            { type: "model", id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5" },
          ],
        },
      ]),
    );
    const availability = await getClaudeModelAvailability({ forceRefresh: true });
    expect(availability.exhaustive).toBe(true);
    expect(availability.models.find((m) => m.id === "claude-opus-5")?.status).toBe("legacy");
    // The key's list is authoritative, so the catalog adds nothing it lacks.
    expect(availability.models.some((m) => m.id === "claude-sonnet-4-6")).toBe(false);
    // The dated Haiku id is the CLI's Haiku, not a second entry.
    expect(availability.models.filter((m) => m.id.startsWith("claude-haiku"))).toHaveLength(1);
    const live = await fetchLiveClaudeModels();
    expect(live?.map((m) => m.id)).toEqual(["claude-haiku-4-5-20251001", "claude-opus-5", "claude-opus-5-5"]);
  });

  it("uses the API list alone when the CLI cannot be asked but a key is set", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-abc123";
    state.cliError = new Error("not signed in");
    vi.stubGlobal("fetch", mockAnthropicApi([{ data: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }] }]));
    const availability = await getClaudeModelAvailability();
    expect(availability.source).toBe("api");
    expect(availability.models.map((m) => m.id)).toEqual(["claude-opus-5-5"]);
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

  it("returns null-live when the API errors, and still lists from the CLI", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-abc123";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) }) as unknown as Response));
    expect(await fetchLiveClaudeModels()).toBeNull();
    const availability = await getClaudeModelAvailability();
    expect(availability.source).toBe("cli");
    expect(availability.exhaustive).toBe(false);
  });

  it("reads the API key from the config file when the env var is absent", async () => {
    state.configFileValue = { llm: { provider: "claude", apiKey: "sk-ant-config-xyz789" } };
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

  it("probe checks the current list by default", async () => {
    const tried: string[] = [];
    await probeClaudeModels({
      runner: async (id) => {
        tried.push(id);
        return true;
      },
    });
    expect(tried.sort()).toEqual(["claude-fable-5-1", "claude-haiku-4-5", "claude-opus-5-5", "claude-sonnet-5"]);
  });
});
