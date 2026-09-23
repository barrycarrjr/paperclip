import type { AdapterModel } from "./types.js";
import { models as codexFallbackModels } from "@paperclipai/adapter-codex-local";
import { listCodexAppServerModels, type CodexAppServerModel } from "@paperclipai/adapter-codex-local/server";
import { readConfigFile } from "../config-file.js";
import { logger } from "../middleware/logger.js";
import { getModelCatalog, refreshModelCatalog } from "../services/model-catalog.js";
import { buildModelList, type LiveModelEntry } from "../services/model-lifecycle.js";
import { cliModelDiscoveryEnabled } from "./claude-models.js";

const OPENAI_MODELS_ENDPOINT = "https://api.openai.com/v1/models";
const OPENAI_MODELS_TIMEOUT_MS = 5000;
/** How long a list is reused before Codex is asked again; refresh bypasses it. */
const LIST_CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * Ids in OpenAI's raw `/v1/models` answer that are not chat or coding models
 * (embeddings, speech, images, moderation), which must never reach a picker.
 */
const NON_CHAT_OPENAI_MODEL_RE =
  /(embedding|whisper|tts|transcribe|audio|realtime|dall-e|image|moderation|search|babbage|davinci|sora|computer-use)/i;

export type CodexModelSource = "codex" | "openai-api" | "curated";

export interface CodexModelAvailability {
  /** What pickers show: everything the account can use except models Codex hides. */
  models: AdapterModel[];
  /** Every id Codex accepts for this account, hidden ones included, when Codex answered. */
  allIds: string[] | null;
  source: CodexModelSource;
  checkedAt: string;
  codexError?: string;
}

let cached: { key: string; expiresAt: number; value: CodexModelAvailability } | null = null;
let inFlight: { key: string; promise: Promise<CodexModelAvailability> } | null = null;

function fingerprint(secret: string): string {
  return `${secret.length}:${secret.slice(-6)}`;
}

function resolveOpenAiApiKey(): string | null {
  const envKey = process.env.OPENAI_API_KEY?.trim();
  if (envKey) return envKey;

  const config = readConfigFile();
  if (config?.llm?.provider !== "openai") return null;
  const configKey = config.llm.apiKey?.trim();
  return configKey && configKey.length > 0 ? configKey : null;
}

/** OpenAI's model list for a key, chat and coding models only, or null when it could not be read. */
export async function fetchOpenAiChatModels(apiKey: string): Promise<AdapterModel[] | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_MODELS_TIMEOUT_MS);
  try {
    const response = await fetch(OPENAI_MODELS_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) return null;

    const payload = (await response.json()) as { data?: unknown };
    const data = Array.isArray(payload.data) ? payload.data : [];
    const models: AdapterModel[] = [];
    const seen = new Set<string>();
    for (const item of data) {
      if (typeof item !== "object" || item === null) continue;
      const id = (item as { id?: unknown }).id;
      if (typeof id !== "string" || id.trim().length === 0) continue;
      const trimmed = id.trim();
      if (seen.has(trimmed) || NON_CHAT_OPENAI_MODEL_RE.test(trimmed)) continue;
      if (!/^(gpt-|o\d|codex|chatgpt-)/i.test(trimmed)) continue;
      seen.add(trimmed);
      models.push({ id: trimmed, label: trimmed });
    }
    return models;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** The environment Codex runs use to sign in, so the list matches the account doing the work. */
async function resolveRunAccountEnv(): Promise<Record<string, string> | undefined> {
  try {
    const { resolveAdapterAccountEnv } = await import("../services/active-account.js");
    return (await resolveAdapterAccountEnv("codex_local"))?.env;
  } catch (err) {
    logger.debug({ err }, "could not resolve the codex_local run account for model discovery");
    return undefined;
  }
}

function toLiveEntry(model: CodexAppServerModel): LiveModelEntry {
  return {
    id: model.id,
    label: model.displayName,
    isDefault: model.isDefault,
    retiresAt: model.retiresAt,
    replacementId: model.upgradeTo,
    notice: model.notice,
    effortLevels: model.effortLevels,
    supportsImages: model.supportsImages,
  };
}

async function loadCodexAvailability(
  env: Record<string, string> | undefined,
  opts: { forceRefresh?: boolean },
): Promise<CodexModelAvailability> {
  const checkedAt = new Date().toISOString();
  const catalog = opts.forceRefresh ? await refreshModelCatalog({ force: true }) : await getModelCatalog();
  const common = { catalog, catalogProvider: "openai" };

  let codexError: string | undefined;
  if (cliModelDiscoveryEnabled()) {
    try {
      const all = await listCodexAppServerModels({ env, includeHidden: true });
      const visible = all.filter((m) => !m.hidden);
      if (visible.length > 0) {
        const built = buildModelList({ ...common, live: visible.map(toLiveEntry), keepLiveOrder: true });
        return { models: built.models, allIds: all.map((m) => m.id), source: "codex", checkedAt };
      }
      codexError = "Codex reported no models";
    } catch (err) {
      codexError = err instanceof Error ? err.message : String(err);
      logger.warn({ err: codexError }, "could not read the Codex model list; using the next source");
    }
  } else {
    codexError = "Asking CLIs for their models is switched off (PAPERCLIP_MODEL_CLI_DISCOVERY)";
  }

  const apiKey = resolveOpenAiApiKey();
  const apiModels = apiKey ? await fetchOpenAiChatModels(apiKey) : null;
  if (apiModels && apiModels.length > 0) {
    const built = buildModelList({ ...common, live: apiModels });
    return { models: built.models, allIds: null, source: "openai-api", checkedAt, codexError };
  }
  const built = buildModelList({ ...common, live: codexFallbackModels });
  return { models: built.models, allIds: null, source: "curated", checkedAt, codexError };
}

/**
 * What codex_local can run for the account runs use, with where the answer
 * came from. Cached for half an hour per account; `forceRefresh` asks again.
 */
export async function getCodexModelAvailability(
  opts: { forceRefresh?: boolean } = {},
): Promise<CodexModelAvailability> {
  const env = cliModelDiscoveryEnabled() ? await resolveRunAccountEnv() : undefined;
  const apiKey = resolveOpenAiApiKey();
  const key = [
    ...Object.entries(env ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => `${name}=${fingerprint(value)}`),
    apiKey ? `api=${fingerprint(apiKey)}` : "",
  ].join("|");
  const now = Date.now();
  if (!opts.forceRefresh && cached && cached.key === key && cached.expiresAt > now) return cached.value;
  if (inFlight && inFlight.key === key) return inFlight.promise;
  const promise = loadCodexAvailability(env, opts)
    .then((value) => {
      const ttl = value.source === "curated" ? 60_000 : LIST_CACHE_TTL_MS;
      cached = { key, expiresAt: Date.now() + ttl, value };
      return value;
    })
    .finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    });
  inFlight = { key, promise };
  return promise;
}

export async function listCodexModels(): Promise<AdapterModel[]> {
  return (await getCodexModelAvailability()).models;
}

export async function refreshCodexModels(): Promise<AdapterModel[]> {
  return (await getCodexModelAvailability({ forceRefresh: true })).models;
}

/**
 * Every model id Codex accepts for the account, hidden ones included, or null
 * when Codex could not be asked. Exhaustive, so the daily check can tell a
 * retired model from one that is merely not shown.
 */
export async function fetchLiveCodexModels(): Promise<AdapterModel[] | null> {
  const availability = await getCodexModelAvailability({ forceRefresh: true });
  if (!availability.allIds) return null;
  return availability.allIds.map((id) => ({ id, label: id }));
}

/** The model Codex itself defaults to for the account, when it said. */
export async function currentCodexDefaultModel(): Promise<string | null> {
  const availability = await getCodexModelAvailability();
  if (availability.source !== "codex") return null;
  return availability.models.find((m) => m.isDefault)?.id ?? null;
}

export function resetCodexModelsCacheForTests() {
  cached = null;
  inFlight = null;
}
