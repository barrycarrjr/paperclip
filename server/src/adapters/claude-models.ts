import { execFile } from "node:child_process";
import type { AdapterModel } from "./types.js";
import {
  claudeCliRowsToModels,
  deriveClaudeModelLabel,
  listClaudeModels as listCuratedClaudeModels,
  readClaudeCliModels,
} from "@paperclipai/adapter-claude-local/server";
import { readConfigFile } from "../config-file.js";
import { logger } from "../middleware/logger.js";
import { getModelCatalog, refreshModelCatalog } from "../services/model-catalog.js";
import { buildModelList, type LiveModelEntry } from "../services/model-lifecycle.js";

const ANTHROPIC_MODELS_ENDPOINT = "https://api.anthropic.com/v1/models";
const ANTHROPIC_MODELS_TIMEOUT_MS = 5000;
const ANTHROPIC_MODELS_MAX_PAGES = 10;
const ANTHROPIC_VERSION = "2023-06-01";
/**
 * How long a list is reused before the CLI is asked again. A new model shows
 * up once the installed CLI knows it; the daily refresh and the picker's
 * refresh button both bypass this.
 */
const LIST_CACHE_TTL_MS = 30 * 60 * 1000;

export type ClaudeModelSource = "cli" | "api" | "catalog" | "curated" | "bedrock";

export interface ClaudeModelAvailability {
  models: AdapterModel[];
  /** Where the list came from, most authoritative first: the CLI, the API, the public catalog, the built-in list. */
  source: ClaudeModelSource;
  /**
   * True only when the list names every model the account can run, which only
   * the Anthropic API gives. The CLI lists current models only, so a model
   * missing from its list may still run.
   */
  exhaustive: boolean;
  checkedAt: string;
  /** Released models the installed CLI does not offer yet: it needs an update first. */
  needsNewerCli: string[];
  /** Why the CLI could not be asked, when it could not. */
  cliError?: string;
}

let cached: { key: string; expiresAt: number; value: ClaudeModelAvailability } | null = null;
let inFlight: { key: string; promise: Promise<ClaudeModelAvailability> } | null = null;

function fingerprint(secret: string): string {
  return `${secret.length}:${secret.slice(-6)}`;
}

/**
 * Bedrock auth uses region-qualified model IDs that neither the CLI picker
 * nor the Anthropic API serve, so under Bedrock the curated Bedrock list
 * stays. Mirrors the check in the claude-local adapter's models.ts.
 */
function isBedrockEnv(): boolean {
  return (
    process.env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    process.env.CLAUDE_CODE_USE_BEDROCK === "true" ||
    (typeof process.env.ANTHROPIC_BEDROCK_BASE_URL === "string" &&
      process.env.ANTHROPIC_BEDROCK_BASE_URL.trim().length > 0)
  );
}

/** `PAPERCLIP_MODEL_CLI_DISCOVERY=off` stops Paperclip from asking provider CLIs for their model lists. */
export function cliModelDiscoveryEnabled(): boolean {
  return !/^(off|false|0|no|disabled)$/i.test(process.env.PAPERCLIP_MODEL_CLI_DISCOVERY?.trim() ?? "");
}

/** An Anthropic API key from the environment or the config file, when there is one. */
function resolveAnthropicApiKey(): string | null {
  const envKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (envKey) return envKey;
  const config = readConfigFile();
  if (config?.llm?.provider !== "claude") return null;
  const configKey = config.llm.apiKey?.trim();
  return configKey && configKey.length > 0 ? configKey : null;
}

interface AnthropicApiModel {
  id?: unknown;
  display_name?: unknown;
}

/**
 * Fetch the models this Anthropic key can use, following pagination. Returns
 * null on any transport/auth failure so callers can distinguish "couldn't
 * check" from "no models".
 */
export async function fetchAnthropicModelsFromApi(apiKey: string): Promise<AdapterModel[] | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ANTHROPIC_MODELS_TIMEOUT_MS);
  try {
    const collected: AdapterModel[] = [];
    const seen = new Set<string>();
    let afterId: string | undefined;
    for (let page = 0; page < ANTHROPIC_MODELS_MAX_PAGES; page++) {
      const url = new URL(ANTHROPIC_MODELS_ENDPOINT);
      url.searchParams.set("limit", "1000");
      if (afterId) url.searchParams.set("after_id", afterId);
      const response = await fetch(url, {
        headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as { data?: unknown; has_more?: unknown; last_id?: unknown };
      const data = Array.isArray(payload.data) ? (payload.data as AnthropicApiModel[]) : [];
      for (const item of data) {
        if (typeof item !== "object" || item === null) continue;
        const id = typeof item.id === "string" ? item.id.trim() : "";
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const label = typeof item.display_name === "string" && item.display_name.trim() ? item.display_name.trim() : id;
        collected.push({ id, label });
      }
      if (payload.has_more === true && typeof payload.last_id === "string" && payload.last_id) {
        afterId = payload.last_id;
      } else {
        break;
      }
    }
    return collected.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }));
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Authoritative live model list for claude_local, or null when it can't be
 * determined. Only an Anthropic API key gives an exhaustive answer; the CLI
 * lists current models only, and Bedrock and subscription-only setups return
 * null so agents are never auto-paused against a partial list (see the
 * model-refresh service).
 */
export async function fetchLiveClaudeModels(): Promise<AdapterModel[] | null> {
  if (isBedrockEnv()) return null;
  const apiKey = resolveAnthropicApiKey();
  if (!apiKey) return null;
  return fetchAnthropicModelsFromApi(apiKey);
}

/** The environment runs of this adapter use to sign in, so the list matches the account doing the work. */
async function resolveRunAccountEnv(): Promise<Record<string, string> | undefined> {
  try {
    const { resolveAdapterAccountEnv } = await import("../services/active-account.js");
    return (await resolveAdapterAccountEnv("claude_local"))?.env;
  } catch (err) {
    logger.debug({ err }, "could not resolve the claude_local run account for model discovery");
    return undefined;
  }
}

function accountCacheKey(env: Record<string, string> | undefined, apiKey: string | null): string {
  const parts = Object.entries(env ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${fingerprint(value)}`);
  if (apiKey) parts.push(`api=${fingerprint(apiKey)}`);
  return parts.join("|") || "machine";
}

async function loadClaudeAvailability(
  accountEnv: Record<string, string> | undefined,
  opts: { forceRefresh?: boolean } = {},
): Promise<ClaudeModelAvailability> {
  const checkedAt = new Date().toISOString();
  if (isBedrockEnv()) {
    return {
      models: await listCuratedClaudeModels(),
      source: "bedrock",
      exhaustive: false,
      checkedAt,
      needsNewerCli: [],
    };
  }

  const catalog = opts.forceRefresh ? await refreshModelCatalog({ force: true }) : await getModelCatalog();
  const apiKey = resolveAnthropicApiKey();
  const apiModels = apiKey ? await fetchAnthropicModelsFromApi(apiKey) : null;

  let cliModels: LiveModelEntry[] | null = null;
  let cliError: string | undefined;
  if (cliModelDiscoveryEnabled()) {
    try {
      const listing = await readClaudeCliModels({ env: accountEnv });
      const models = claudeCliRowsToModels(listing.rows);
      if (models.length > 0) cliModels = models;
      else cliError = "Claude Code reported no models";
    } catch (err) {
      cliError = err instanceof Error ? err.message : String(err);
      logger.warn({ err: cliError }, "could not read the Claude Code model list; using the next source");
    }
  } else {
    cliError = "Asking CLIs for their models is switched off (PAPERCLIP_MODEL_CLI_DISCOVERY)";
  }

  const common = { catalog, catalogProvider: "anthropic", labelFor: deriveClaudeModelLabel };
  if (cliModels) {
    // With a key, the API's complete list adds the older models the CLI
    // picker leaves out; without one, the catalog does.
    const cliIds = new Set(cliModels.flatMap((m) => [m.id, ...(m.aliases ?? [])]));
    const built = buildModelList({
      ...common,
      live: [...cliModels, ...(apiModels ?? []).filter((m) => !cliIds.has(m.id))],
      catalogAdditions: apiModels ? "none" : "older",
      keepLiveOrder: true,
    });
    if (built.needsNewerTool.length > 0) {
      logger.info({ models: built.needsNewerTool }, "newer Claude models exist than the installed Claude Code offers");
    }
    return { models: built.models, source: "cli", exhaustive: Boolean(apiModels), checkedAt, needsNewerCli: built.needsNewerTool, cliError };
  }
  if (apiModels && apiModels.length > 0) {
    const built = buildModelList({ ...common, live: apiModels });
    return { models: built.models, source: "api", exhaustive: true, checkedAt, needsNewerCli: [], cliError };
  }
  if (catalog?.providers.anthropic) {
    const built = buildModelList({ ...common, live: [], catalogAdditions: "all" });
    if (built.models.length > 0) {
      return { models: built.models, source: "catalog", exhaustive: false, checkedAt, needsNewerCli: [], cliError };
    }
  }
  const built = buildModelList({ ...common, live: await listCuratedClaudeModels(), catalog: null });
  return { models: built.models, source: "curated", exhaustive: false, checkedAt, needsNewerCli: [], cliError };
}

/**
 * What claude_local can run for the account runs use, with where the answer
 * came from. Cached for half an hour per account; `forceRefresh` asks again.
 */
export async function getClaudeModelAvailability(
  opts: { forceRefresh?: boolean } = {},
): Promise<ClaudeModelAvailability> {
  // The account only matters when the CLI is asked; resolving it can itself
  // ask Switchboard, which is not worth doing for a list that ignores it.
  const accountEnv = !isBedrockEnv() && cliModelDiscoveryEnabled() ? await resolveRunAccountEnv() : undefined;
  const key = accountCacheKey(accountEnv, resolveAnthropicApiKey());
  const now = Date.now();
  if (!opts.forceRefresh && cached && cached.key === key && cached.expiresAt > now) return cached.value;
  if (inFlight && inFlight.key === key) return inFlight.promise;
  const promise = loadClaudeAvailability(accountEnv, opts)
    .then((value) => {
      // A fallback answer is kept only briefly, so a CLI that was busy or
      // updating is asked again soon rather than half an hour later.
      const ttl = value.source === "cli" || value.source === "api" ? LIST_CACHE_TTL_MS : 60_000;
      cached = { key, expiresAt: Date.now() + ttl, value };
      return value;
    })
    .finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    });
  inFlight = { key, promise };
  return promise;
}

export async function listClaudeModelsWithDiscovery(): Promise<AdapterModel[]> {
  return (await getClaudeModelAvailability()).models;
}

export async function refreshClaudeModelsWithDiscovery(): Promise<AdapterModel[]> {
  return (await getClaudeModelAvailability({ forceRefresh: true })).models;
}

// ---------------------------------------------------------------------------
// Probe mode (opt-in): validate candidate models by actually invoking the CLI.
// ---------------------------------------------------------------------------

export type ClaudeModelProbeRunner = (modelId: string) => Promise<boolean>;

/**
 * Default probe runner: spawn the Claude Code CLI in print mode against a
 * candidate model with a one-token prompt and a single turn. Exit code 0 means
 * the subscription/key can actually run that model. This spends a tiny amount
 * per model, so it is opt-in (never the nightly path).
 */
function defaultProbeRunner(modelId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = execFile(
      "claude",
      ["-p", "ok", "--model", modelId, "--max-turns", "1", "--dangerously-skip-permissions"],
      { timeout: 30_000, windowsHide: true },
      (err) => resolve(!err),
    );
    child.on("error", () => resolve(false));
  });
}

/**
 * Return the subset of `candidates` (default: the current model list) that the
 * local CLI can actually run right now. Runs probes with limited concurrency so
 * we don't spawn a CLI per model all at once.
 */
export async function probeClaudeModels(opts?: {
  candidates?: AdapterModel[];
  runner?: ClaudeModelProbeRunner;
  concurrency?: number;
}): Promise<AdapterModel[]> {
  const candidates = opts?.candidates ?? (await listClaudeModelsWithDiscovery()).map((m) => ({ ...m }));
  const runner = opts?.runner ?? defaultProbeRunner;
  const concurrency = Math.max(1, opts?.concurrency ?? 3);

  const available: AdapterModel[] = [];
  let index = 0;
  async function worker(): Promise<void> {
    while (index < candidates.length) {
      const model = candidates[index++];
      try {
        if (await runner(model.id)) available.push(model);
      } catch {
        // A probe that throws is treated as "unavailable".
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker()));
  return available.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }));
}

export function resetClaudeModelsCacheForTests(): void {
  cached = null;
  inFlight = null;
}
