import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getModelCatalog,
  lookupCatalogModel,
  modelCatalogFilePath,
  modelCatalogUrl,
  peekModelCatalog,
  refreshModelCatalog,
  resetModelCatalogForTests,
  slimModelsDevPayload,
} from "../services/model-catalog.js";

vi.mock("../middleware/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const URL_UNDER_TEST = "https://catalog.test/api.json";

// The shape models.dev serves, cut down to what matters.
const payload = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-opus-5-5": {
        id: "claude-opus-5-5",
        name: "Claude Opus 5.5",
        family: "claude-opus",
        release_date: "2026-09-22",
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
        limit: { context: 1000000, output: 128000 },
        cost: { input: 4, output: 20 },
      },
    },
  },
  openai: {
    id: "openai",
    models: {
      "o4-mini": { id: "o4-mini", family: "o-mini", release_date: "2025-04-16", status: "deprecated", modalities: { input: ["text", "image"] } },
      "text-only": { id: "text-only", release_date: "not-a-date", modalities: { input: ["text"] } },
      "image-maker": { id: "image-maker", modalities: { input: ["text"], output: ["image"] } },
    },
  },
  emptyProvider: { id: "x", models: {} },
  notAProvider: "junk",
};

function response(body: unknown, init: { status?: number; etag?: string } = {}): Response {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(init.etag ? { etag: init.etag } : {}),
    json: async () => body,
  } as unknown as Response;
}

describe("slimModelsDevPayload", () => {
  it("keeps the fields Paperclip uses and drops the rest", () => {
    const providers = slimModelsDevPayload(payload);
    expect(providers.anthropic["claude-opus-5-5"]).toEqual({
      id: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      family: "claude-opus",
      releaseDate: "2026-09-22",
      supportsImages: true,
      outputsText: true,
      effortLevels: ["low", "medium", "high", "xhigh", "max"],
      contextWindow: 1000000,
    });
    expect(providers.openai["o4-mini"]).toMatchObject({ status: "deprecated", supportsImages: true });
    expect(providers.openai["text-only"]).toEqual({ id: "text-only", supportsImages: false });
    expect(providers.openai["image-maker"]).toMatchObject({ outputsText: false });
  });

  it("skips empty and malformed providers", () => {
    const providers = slimModelsDevPayload(payload);
    expect(Object.keys(providers).sort()).toEqual(["anthropic", "openai"]);
    expect(slimModelsDevPayload(null)).toEqual({});
  });
});

describe("model catalog cache", () => {
  let home: string;
  const originalHome = process.env.PAPERCLIP_HOME;
  const originalUrl = process.env.PAPERCLIP_MODEL_CATALOG_URL;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-catalog-"));
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_MODEL_CATALOG_URL = URL_UNDER_TEST;
    resetModelCatalogForTests();
  });

  afterEach(async () => {
    resetModelCatalogForTests();
    if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalHome;
    if (originalUrl === undefined) delete process.env.PAPERCLIP_MODEL_CATALOG_URL;
    else process.env.PAPERCLIP_MODEL_CATALOG_URL = originalUrl;
    await fs.rm(home, { recursive: true, force: true });
  });

  it("is switched off by PAPERCLIP_MODEL_CATALOG_URL=off and never fetches", async () => {
    process.env.PAPERCLIP_MODEL_CATALOG_URL = "off";
    const fetchImpl = vi.fn();
    expect(modelCatalogUrl()).toBeNull();
    expect(await getModelCatalog({ fetchImpl })).toBeNull();
    expect(await refreshModelCatalog({ force: true, fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("downloads on first read, saves a copy on disk, and serves it from memory after", async () => {
    const fetchImpl = vi.fn(async () => response(payload, { etag: '"v1"' }));
    const catalog = await getModelCatalog({ fetchImpl });
    expect(lookupCatalogModel(catalog, "anthropic", "claude-opus-5-5")?.releaseDate).toBe("2026-09-22");
    expect(catalog?.etag).toBe('"v1"');
    const saved = JSON.parse(await fs.readFile(modelCatalogFilePath(), "utf8"));
    expect(saved.providers.anthropic["claude-opus-5-5"].family).toBe("claude-opus");

    await getModelCatalog({ fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(peekModelCatalog()?.source).toBe(URL_UNDER_TEST);
  });

  it("starts from the saved copy after a restart without downloading", async () => {
    await refreshModelCatalog({ force: true, fetchImpl: vi.fn(async () => response(payload)) });
    resetModelCatalogForTests();
    const fetchImpl = vi.fn();
    const catalog = await getModelCatalog({ fetchImpl });
    expect(lookupCatalogModel(catalog, "anthropic", "claude-opus-5-5")).not.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("revalidates with the ETag and keeps the copy on a 304", async () => {
    const t0 = Date.parse("2026-09-23T00:00:00Z");
    await refreshModelCatalog({ force: true, now: t0, fetchImpl: vi.fn(async () => response(payload, { etag: '"v1"' })) });
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)["if-none-match"]).toBe('"v1"');
      return response(null, { status: 304 });
    });
    const catalog = await refreshModelCatalog({ force: true, now: t0 + 2 * 60 * 60 * 1000, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(lookupCatalogModel(catalog, "anthropic", "claude-opus-5-5")).not.toBeNull();
  });

  it("keeps the last good copy when a download fails, and does not retry within the hour", async () => {
    const t0 = Date.parse("2026-09-23T00:00:00Z");
    await refreshModelCatalog({ force: true, now: t0, fetchImpl: vi.fn(async () => response(payload)) });
    const failing = vi.fn(async () => {
      throw new Error("offline");
    });
    const afterFailure = await refreshModelCatalog({ force: true, now: t0 + 2 * 60 * 60 * 1000, fetchImpl: failing });
    expect(lookupCatalogModel(afterFailure, "anthropic", "claude-opus-5-5")).not.toBeNull();
    await refreshModelCatalog({ force: true, now: t0 + 2 * 60 * 60 * 1000 + 60_000, fetchImpl: failing });
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it("does not replace a good copy with an empty download", async () => {
    const t0 = Date.parse("2026-09-23T00:00:00Z");
    await refreshModelCatalog({ force: true, now: t0, fetchImpl: vi.fn(async () => response(payload)) });
    const catalog = await refreshModelCatalog({
      force: true,
      now: t0 + 2 * 60 * 60 * 1000,
      fetchImpl: vi.fn(async () => response({})),
    });
    expect(lookupCatalogModel(catalog, "anthropic", "claude-opus-5-5")).not.toBeNull();
  });

  it("answers the first read without a copy within the wait, rather than blocking on a slow download", async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
    const started = Date.now();
    expect(await getModelCatalog({ fetchImpl, waitMs: 50 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("lets only the first reader wait on a download; later readers answer at once and never start another", async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
    await getModelCatalog({ fetchImpl, waitMs: 20 });
    const started = Date.now();
    expect(await getModelCatalog({ fetchImpl, waitMs: 5_000 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reads the saved copy once when several readers arrive together at startup", async () => {
    await refreshModelCatalog({ force: true, fetchImpl: vi.fn(async () => response(payload)) });
    resetModelCatalogForTests();
    const fetchImpl = vi.fn();
    const [a, b] = await Promise.all([getModelCatalog({ fetchImpl }), getModelCatalog({ fetchImpl })]);
    expect(a?.source).toBe(URL_UNDER_TEST);
    expect(b?.source).toBe(URL_UNDER_TEST);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("lookupCatalogModel", () => {
  const catalog = {
    source: "test",
    fetchedAt: "2026-09-23T00:00:00Z",
    providers: slimModelsDevPayload(payload),
  };

  it("finds a model by id, without a context suffix, and without a snapshot date", () => {
    expect(lookupCatalogModel(catalog, "anthropic", "claude-opus-5-5")?.name).toBe("Claude Opus 5.5");
    expect(lookupCatalogModel(catalog, "anthropic", "claude-opus-5-5[1m]")?.name).toBe("Claude Opus 5.5");
    expect(lookupCatalogModel(catalog, "anthropic", "claude-opus-5-5-20260922")?.name).toBe("Claude Opus 5.5");
  });

  it("returns null for unknown providers, models or no catalog", () => {
    expect(lookupCatalogModel(catalog, "nobody", "x")).toBeNull();
    expect(lookupCatalogModel(catalog, "anthropic", "claude-opus-9")).toBeNull();
    expect(lookupCatalogModel(null, "anthropic", "claude-opus-5-5")).toBeNull();
  });
});
