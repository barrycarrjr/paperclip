import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchLiveGeminiModels,
  listGeminiModels,
  refreshGeminiModels,
  resetGeminiModelsCacheForTests,
} from "../adapters/gemini-models.js";

const ORIGINAL_ENV = { ...process.env };

function mockGeminiApi(pages: Array<{ models: unknown[]; nextPageToken?: string }>) {
  let call = 0;
  return vi.fn(async () => {
    const page = pages[Math.min(call, pages.length - 1)];
    call += 1;
    return { ok: true, json: async () => page } as unknown as Response;
  });
}

describe("gemini model discovery", () => {
  beforeEach(() => {
    resetGeminiModelsCacheForTests();
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns the curated fallback list when no API key is set", async () => {
    const models = await listGeminiModels();
    // The full curated default list (auto + concrete models) is the offline fallback.
    expect(models.some((m) => m.id === "auto")).toBe(true);
    expect(models.some((m) => m.id === "gemini-2.5-pro")).toBe(true);
    expect(models.length).toBeGreaterThan(1);
  });

  it("fetchLiveGeminiModels is null with no key (can't determine, so it never triggers a false 'model retired')", async () => {
    expect(await fetchLiveGeminiModels()).toBeNull();
  });

  it("lists generateContent models with the models/ prefix stripped, keeping 'auto'", async () => {
    process.env.GEMINI_API_KEY = "test-key-123456";
    vi.stubGlobal(
      "fetch",
      mockGeminiApi([
        {
          models: [
            { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro", supportedGenerationMethods: ["generateContent"] },
            { name: "models/text-embedding-004", displayName: "Embed", supportedGenerationMethods: ["embedContent"] },
          ],
        },
      ]),
    );
    const models = await refreshGeminiModels();
    expect(models).toContainEqual({ id: "auto", label: "Auto" });
    expect(models).toContainEqual({ id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" });
    // Embedding-only model (no generateContent) is excluded.
    expect(models.some((m) => m.id === "text-embedding-004")).toBe(false);
    // Curated concrete defaults are NOT merged into a successful live result, so
    // a model the live API no longer returns drops off (retired models disappear).
    expect(models.some((m) => m.id === "gemini-2.0-flash")).toBe(false);
    expect(models.map((m) => m.id).sort()).toEqual(["auto", "gemini-2.5-pro"]);
  });

  it("follows pagination via nextPageToken", async () => {
    process.env.GEMINI_API_KEY = "test-key-123456";
    vi.stubGlobal(
      "fetch",
      mockGeminiApi([
        { models: [{ name: "models/gemini-a", supportedGenerationMethods: ["generateContent"] }], nextPageToken: "p2" },
        { models: [{ name: "models/gemini-b", supportedGenerationMethods: ["generateContent"] }] },
      ]),
    );
    const models = await fetchLiveGeminiModels();
    expect(models?.map((m) => m.id).sort()).toEqual(["auto", "gemini-a", "gemini-b"]);
  });

  it("falls back to 'auto' (and returns null from fetchLive) when the API errors", async () => {
    process.env.GEMINI_API_KEY = "test-key-123456";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) }) as unknown as Response));
    expect(await fetchLiveGeminiModels()).toBeNull();
    // No live answer + no cache: serve the full curated fallback, not an empty menu.
    const models = await listGeminiModels();
    expect(models.some((m) => m.id === "auto")).toBe(true);
    expect(models.length).toBeGreaterThan(1);
  });
});
