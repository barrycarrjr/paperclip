/**
 * Model lists for Clippy's direct API-key providers (Anthropic, OpenAI,
 * Gemini), read from each provider's own models endpoint and marked current,
 * legacy or retiring from the public catalog.
 *
 * These replace the literal lists the chat providers used to carry, which
 * never gained a new model or lost a retired one without a code change. When
 * a provider's endpoint cannot be read, the catalog's current models stand in,
 * and only with neither does a built-in list apply.
 *
 * @module server/services/chat-model-lists
 */

import { models as curatedClaudeModels } from "@paperclipai/adapter-claude-local";
import { models as curatedCodexModels } from "@paperclipai/adapter-codex-local";
import { models as curatedGeminiModels, DEFAULT_GEMINI_LOCAL_MODEL } from "@paperclipai/adapter-gemini-local";
import type { AdapterModel } from "../adapters/types.js";
import { fetchAnthropicModelsFromApi } from "../adapters/claude-models.js";
import { fetchOpenAiChatModels } from "../adapters/codex-models.js";
import { fetchLiveGeminiModels } from "../adapters/gemini-models.js";
import { getModelCatalog, lookupCatalogModel, type ModelCatalog } from "./model-catalog.js";
import { buildModelList, rankModelsForDefault } from "./model-lifecycle.js";

export type NativeChatProvider = "anthropic" | "openai" | "gemini";

/** Which models.dev provider describes each chat provider's models. */
const CATALOG_PROVIDER: Record<NativeChatProvider, string> = {
  anthropic: "anthropic",
  openai: "openai",
  gemini: "google",
};

const LIST_CACHE_TTL_MS = 30 * 60 * 1000;
const FALLBACK_CACHE_TTL_MS = 60 * 1000;

const cache = new Map<NativeChatProvider, { key: string; expiresAt: number; models: AdapterModel[] }>();
/** What each provider's list said last time, so synchronous callers can use it. */
const lastKnown = new Map<NativeChatProvider, AdapterModel[]>();
/**
 * Image support by model id, from the direct providers' lists only. Adapter
 * lists stay out on purpose: a CLI can report its own limits for a model id
 * that the provider's API serves differently, and one id must mean one answer.
 */
const imageSupport = new Map<string, boolean>();

function fingerprint(secret: string): string {
  return `${secret.length}:${secret.slice(-6)}`;
}

/** The models a provider's built-in list offers for chat, used only when nothing live is reachable. */
function curatedFor(provider: NativeChatProvider): AdapterModel[] {
  if (provider === "anthropic") return curatedClaudeModels.map((m) => ({ ...m }));
  if (provider === "openai") return curatedCodexModels.filter((m) => /^gpt-/.test(m.id)).map((m) => ({ ...m }));
  return curatedGeminiModels.filter((m) => m.id !== DEFAULT_GEMINI_LOCAL_MODEL).map((m) => ({ ...m }));
}

/**
 * OpenAI models that answer only through the Responses API (the `-pro`
 * models and the Codex coding models). Clippy's OpenAI provider uses Chat
 * Completions, so offering them would give a model that fails every message.
 */
const OPENAI_RESPONSES_ONLY_RE = /(-pro\b|codex)/i;

async function readLive(provider: NativeChatProvider, apiKey: string): Promise<AdapterModel[] | null> {
  if (provider === "anthropic") return fetchAnthropicModelsFromApi(apiKey);
  if (provider === "openai") {
    const models = await fetchOpenAiChatModels(apiKey);
    return models ? models.filter((m) => !OPENAI_RESPONSES_ONLY_RE.test(m.id)) : null;
  }
  const gemini = await fetchLiveGeminiModels();
  return gemini ? gemini.filter((m) => m.id !== DEFAULT_GEMINI_LOCAL_MODEL) : null;
}

function catalogCurrent(provider: NativeChatProvider, catalog: ModelCatalog | null): AdapterModel[] {
  if (!catalog?.providers[CATALOG_PROVIDER[provider]]) return [];
  return buildModelList({ live: [], catalog, catalogProvider: CATALOG_PROVIDER[provider], catalogAdditions: "all" })
    .models.filter((m) => m.status === "current");
}

function remember(provider: NativeChatProvider, models: AdapterModel[]): AdapterModel[] {
  lastKnown.set(provider, models);
  for (const model of models) {
    if (model.supportsImages !== undefined) imageSupport.set(model.id, model.supportsImages);
  }
  return models;
}

/**
 * The models a direct provider offers for this key, marked with their
 * lifecycle. Cached for half an hour per key.
 */
export async function listNativeChatModels(
  provider: NativeChatProvider,
  apiKey: string,
  opts: { forceRefresh?: boolean } = {},
): Promise<AdapterModel[]> {
  const key = fingerprint(apiKey);
  const hit = cache.get(provider);
  if (!opts.forceRefresh && hit && hit.key === key && hit.expiresAt > Date.now()) return hit.models;

  const catalog = await getModelCatalog();
  const live = await readLive(provider, apiKey);
  let models: AdapterModel[];
  let ttl = LIST_CACHE_TTL_MS;
  if (live && live.length > 0) {
    models = buildModelList({ live, catalog, catalogProvider: CATALOG_PROVIDER[provider] }).models;
  } else {
    ttl = FALLBACK_CACHE_TTL_MS;
    models = catalogCurrent(provider, catalog);
    if (models.length === 0) {
      models = buildModelList({ live: curatedFor(provider), catalog, catalogProvider: CATALOG_PROVIDER[provider] }).models;
    }
  }
  cache.set(provider, { key, expiresAt: Date.now() + ttl, models });
  return remember(provider, models);
}

/**
 * The model to use when a caller names none: the best current model the
 * provider offered last time it was asked, else the best of its built-in
 * list. Synchronous for callers that cannot wait; `listNativeChatModels`
 * keeps it current.
 */
export function bestKnownNativeModel(provider: NativeChatProvider): string {
  const known = lastKnown.get(provider);
  const candidates =
    known && known.length > 0
      ? known
      : buildModelList({ live: curatedFor(provider), catalog: null }).models;
  return rankModelsForDefault(candidates)[0]?.id ?? curatedFor(provider)[0]?.id ?? "";
}

/** Whether a model accepts images, from any list or catalog entry seen, or null when nothing says. */
export function knownImageSupport(modelId: string, catalog: ModelCatalog | null): boolean | null {
  const listed = imageSupport.get(modelId);
  if (listed !== undefined) return listed;
  for (const provider of ["anthropic", "openai", "google"]) {
    const entry = lookupCatalogModel(catalog, provider, modelId);
    if (entry?.supportsImages !== undefined) return entry.supportsImages;
  }
  return null;
}

export function resetChatModelListsForTests(): void {
  cache.clear();
  lastKnown.clear();
  imageSupport.clear();
}
