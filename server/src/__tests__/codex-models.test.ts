import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerModel } from "@paperclipai/adapter-codex-local/server";

const state = vi.hoisted(() => ({
  models: [] as CodexAppServerModel[],
  error: null as Error | null,
  calls: [] as Array<{ env?: Record<string, string>; includeHidden?: boolean }>,
  accountEnv: null as Record<string, string> | null,
}));

vi.mock("@paperclipai/adapter-codex-local/server", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-codex-local/server")>(
    "@paperclipai/adapter-codex-local/server",
  );
  return {
    ...actual,
    listCodexAppServerModels: async (opts: { env?: Record<string, string>; includeHidden?: boolean } = {}) => {
      state.calls.push({ env: opts.env, includeHidden: opts.includeHidden });
      if (state.error) throw state.error;
      return opts.includeHidden ? state.models : state.models.filter((m) => !m.hidden);
    },
  };
});

vi.mock("../services/active-account.js", () => ({
  resolveAdapterAccountEnv: async () => (state.accountEnv ? { env: state.accountEnv } : null),
}));

vi.mock("../config-file.js", () => ({ readConfigFile: () => null }));

import {
  currentCodexDefaultModel,
  fetchLiveCodexModels,
  getCodexModelAvailability,
  listCodexModels,
  refreshCodexModels,
  resetCodexModelsCacheForTests,
} from "../adapters/codex-models.js";

// What `codex app-server` model/list gave on 2026-09-23 (trimmed).
const CODEX_MODELS: CodexAppServerModel[] = [
  { id: "gpt-6-astra", displayName: "GPT-6-Astra", hidden: false, isDefault: true, supportsImages: true },
  { id: "gpt-6-sol", displayName: "GPT-6-Sol", hidden: false, isDefault: false },
  { id: "gpt-reserve", displayName: "gpt-reserve", hidden: true, isDefault: false },
  { id: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", hidden: false, isDefault: false },
  {
    id: "gpt-5.5",
    displayName: "GPT-5.5",
    hidden: false,
    isDefault: false,
    upgradeTo: "gpt-5.6-sol",
    retiresAt: "2026-10-14T19:00:00.000Z",
    notice: "GPT-5.5 retires on October 14, 2026. Switch to GPT-5.6 Sol to continue working in Codex.",
  },
];

const ORIGINAL_ENV = { ...process.env };

describe("codex model discovery", () => {
  beforeEach(() => {
    resetCodexModelsCacheForTests();
    state.models = CODEX_MODELS;
    state.error = null;
    state.calls = [];
    state.accountEnv = null;
    delete process.env.OPENAI_API_KEY;
    process.env.PAPERCLIP_MODEL_CLI_DISCOVERY = "on";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  it("lists what Codex offers the account, leaving out the models Codex hides", async () => {
    const models = await listCodexModels();
    // Codex's own order, retiring last. (With no catalog in tests, nothing
    // says gpt-5.6-sol and gpt-6-sol are one family, so neither is "older".)
    expect(models.map((m) => m.id)).toEqual(["gpt-6-astra", "gpt-6-sol", "gpt-5.6-sol", "gpt-5.5"]);
    expect(models[0]).toMatchObject({ label: "GPT-6-Astra", isDefault: true, status: "current", supportsImages: true });
  });

  it("carries Codex's own retirement date, successor and notice", async () => {
    const retiring = (await listCodexModels()).find((m) => m.id === "gpt-5.5");
    expect(retiring).toMatchObject({
      status: "deprecated",
      retiresAt: "2026-10-14T19:00:00.000Z",
      replacementId: "gpt-5.6-sol",
      notice: expect.stringContaining("retires on October 14, 2026"),
    });
  });

  it("gives the daily check every id Codex accepts, hidden ones included", async () => {
    const live = await fetchLiveCodexModels();
    expect(live?.map((m) => m.id)).toContain("gpt-reserve");
    expect(state.calls.at(-1)?.includeHidden).toBe(true);
  });

  it("reports Codex's own default for new agents", async () => {
    expect(await currentCodexDefaultModel()).toBe("gpt-6-astra");
  });

  it("asks Codex as the account runs use, and caches per account", async () => {
    state.accountEnv = { CODEX_HOME: "/lanes/codex-2" };
    await listCodexModels();
    await listCodexModels();
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].env).toEqual({ CODEX_HOME: "/lanes/codex-2" });
    await refreshCodexModels();
    expect(state.calls).toHaveLength(2);
  });

  it("falls back to the built-in list, and names no default, when Codex cannot be asked", async () => {
    state.error = new Error("Command not found in PATH: \"codex\"");
    const availability = await getCodexModelAvailability();
    expect(availability.source).toBe("curated");
    expect(availability.codexError).toContain("not found");
    expect(availability.allIds).toBeNull();
    expect(await fetchLiveCodexModels()).toBeNull();
    expect(await currentCodexDefaultModel()).toBeNull();
  });

  it("never spawns Codex when discovery is switched off", async () => {
    process.env.PAPERCLIP_MODEL_CLI_DISCOVERY = "off";
    const availability = await getCodexModelAvailability();
    expect(state.calls).toHaveLength(0);
    expect(availability.source).toBe("curated");
  });
});
