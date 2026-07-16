import type { AdapterModel } from "./types.js";
import { models as geminiFallbackModels, DEFAULT_GEMINI_LOCAL_MODEL } from "@paperclipai/adapter-gemini-local";

/**
 * The "auto" entry is the Gemini CLI's own model picker, not a concrete model
 * that a provider can retire, so it is always kept in the live list. The other
 * curated defaults are only a fallback for when discovery can't run. When the
 * live API answers, its concrete list is authoritative so retired models drop.
 */
const AUTO_MODELS: AdapterModel[] = geminiFallbackModels.filter((m) => m.id === DEFAULT_GEMINI_LOCAL_MODEL);

const GEMINI_MODELS_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODELS_TIMEOUT_MS = 5000;
const GEMINI_MODELS_CACHE_TTL_MS = 60_000;
const GEMINI_MODELS_MAX_PAGES = 5;

let cached: { keyFingerprint: string; expiresAt: number; models: AdapterModel[] } | null = null;

function fingerprint(apiKey: string): string {
  return `${apiKey.length}:${apiKey.slice(-6)}`;
}

/**
 * gemini_local reads its key from GEMINI_API_KEY / GOOGLE_API_KEY (host env or
 * adapter env). Discovery runs without an agent context, so it can only see the
 * host env, mirroring how codex-models resolves the OpenAI key.
 */
function resolveGeminiApiKey(): string | null {
  const key = process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

function dedupeModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const out: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: model.label.trim() || id });
  }
  return out;
}

interface GeminiApiModel {
  name?: unknown;
  displayName?: unknown;
  supportedGenerationMethods?: unknown;
}

/**
 * Fetch the models this Gemini key can call `generateContent` on, following
 * pagination. Returns null on any transport/auth failure so callers can tell
 * "couldn't check" apart from "no models".
 */
async function fetchGeminiModelsFromApi(apiKey: string): Promise<AdapterModel[] | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_MODELS_TIMEOUT_MS);
  try {
    const collected: AdapterModel[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < GEMINI_MODELS_MAX_PAGES; page++) {
      const url = new URL(GEMINI_MODELS_ENDPOINT);
      url.searchParams.set("pageSize", "1000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      // Key travels in a header, never in the URL/query string.
      const response = await fetch(url, {
        headers: { "x-goog-api-key": apiKey },
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as { models?: unknown; nextPageToken?: unknown };
      const data = Array.isArray(payload.models) ? (payload.models as GeminiApiModel[]) : [];
      for (const item of data) {
        if (typeof item !== "object" || item === null) continue;
        const name = typeof item.name === "string" ? item.name : null;
        if (!name) continue;
        const methods = Array.isArray(item.supportedGenerationMethods)
          ? (item.supportedGenerationMethods as unknown[])
          : [];
        if (!methods.includes("generateContent")) continue;
        const id = name.replace(/^models\//, "");
        const label = typeof item.displayName === "string" && item.displayName.trim() ? item.displayName.trim() : id;
        collected.push({ id, label });
      }
      pageToken = typeof payload.nextPageToken === "string" && payload.nextPageToken ? payload.nextPageToken : undefined;
      if (!pageToken) break;
    }
    return dedupeModels(collected).sort((a, b) =>
      a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }),
    );
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Authoritative live model list for gemini_local: the "auto" default plus every
 * concrete model the configured key can drive, or null when no key is set or
 * the API can't be reached. "auto" is always kept (it is the CLI's own
 * model-picker, not a concrete model that can be retired).
 */
export async function fetchLiveGeminiModels(): Promise<AdapterModel[] | null> {
  const apiKey = resolveGeminiApiKey();
  if (!apiKey) return null;
  const discovered = await fetchGeminiModelsFromApi(apiKey);
  if (discovered === null) return null;
  return dedupeModels([...AUTO_MODELS, ...discovered]);
}

async function loadGeminiModels(opts?: { forceRefresh?: boolean }): Promise<AdapterModel[]> {
  const apiKey = resolveGeminiApiKey();
  const fallback = dedupeModels([...geminiFallbackModels]);
  if (!apiKey) return fallback;

  const now = Date.now();
  const keyFingerprint = fingerprint(apiKey);
  if (!opts?.forceRefresh && cached && cached.keyFingerprint === keyFingerprint && cached.expiresAt > now) {
    return cached.models;
  }

  const discovered = await fetchGeminiModelsFromApi(apiKey);
  if (discovered !== null) {
    const models = dedupeModels([...AUTO_MODELS, ...discovered]);
    cached = { keyFingerprint, expiresAt: now + GEMINI_MODELS_CACHE_TTL_MS, models };
    return models;
  }

  // API unreachable: prefer last-known, else the curated fallback ("auto").
  if (cached && cached.keyFingerprint === keyFingerprint && cached.models.length > 0) {
    return cached.models;
  }
  return fallback;
}

export async function listGeminiModels(): Promise<AdapterModel[]> {
  return loadGeminiModels();
}

export async function refreshGeminiModels(): Promise<AdapterModel[]> {
  return loadGeminiModels({ forceRefresh: true });
}

export function resetGeminiModelsCacheForTests(): void {
  cached = null;
}
