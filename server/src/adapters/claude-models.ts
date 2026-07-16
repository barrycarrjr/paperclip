import { execFile } from "node:child_process";
import type { AdapterModel } from "./types.js";
import { models as claudeCuratedModels } from "@paperclipai/adapter-claude-local";
import { listClaudeModels as listCuratedClaudeModels } from "@paperclipai/adapter-claude-local/server";
import { readConfigFile } from "../config-file.js";

const ANTHROPIC_MODELS_ENDPOINT = "https://api.anthropic.com/v1/models";
const ANTHROPIC_MODELS_TIMEOUT_MS = 5000;
const ANTHROPIC_MODELS_CACHE_TTL_MS = 60_000;
const ANTHROPIC_MODELS_MAX_PAGES = 10;
const ANTHROPIC_VERSION = "2023-06-01";

let cached: { keyFingerprint: string; expiresAt: number; models: AdapterModel[] } | null = null;

function fingerprint(apiKey: string): string {
  return `${apiKey.length}:${apiKey.slice(-6)}`;
}

/**
 * Bedrock auth uses region-qualified model IDs that the Anthropic public
 * `/v1/models` API does not serve, so when Bedrock is configured we keep the
 * curated Bedrock list rather than trying to discover. Mirrors the (internal)
 * check in the claude-local adapter's models.ts.
 */
function isBedrockEnv(): boolean {
  return (
    process.env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    process.env.CLAUDE_CODE_USE_BEDROCK === "true" ||
    (typeof process.env.ANTHROPIC_BEDROCK_BASE_URL === "string" &&
      process.env.ANTHROPIC_BEDROCK_BASE_URL.trim().length > 0)
  );
}

/**
 * The Claude Code CLI has no command that lists a subscription's entitled
 * models, so subscription (setup-token) users can't be auto-discovered. When an
 * ANTHROPIC_API_KEY (env or config file) is present we can query the Anthropic
 * API; otherwise we keep the curated list.
 */
function resolveAnthropicApiKey(): string | null {
  const envKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (envKey) return envKey;
  const config = readConfigFile();
  if (config?.llm?.provider !== "claude") return null;
  const configKey = config.llm.apiKey?.trim();
  return configKey && configKey.length > 0 ? configKey : null;
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

interface AnthropicApiModel {
  id?: unknown;
  display_name?: unknown;
}

/**
 * Fetch the models this Anthropic key can use, following pagination. Returns
 * null on any transport/auth failure so callers can distinguish "couldn't
 * check" from "no models".
 */
async function fetchAnthropicModelsFromApi(apiKey: string): Promise<AdapterModel[] | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ANTHROPIC_MODELS_TIMEOUT_MS);
  try {
    const collected: AdapterModel[] = [];
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
        if (!id) continue;
        const label = typeof item.display_name === "string" && item.display_name.trim() ? item.display_name.trim() : id;
        collected.push({ id, label });
      }
      if (payload.has_more === true && typeof payload.last_id === "string" && payload.last_id) {
        afterId = payload.last_id;
      } else {
        break;
      }
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

async function curatedModels(): Promise<AdapterModel[]> {
  // listCuratedClaudeModels already picks Bedrock vs. Anthropic curated ids.
  return dedupeModels(await listCuratedClaudeModels());
}

/**
 * Authoritative live model list for claude_local, or null when it can't be
 * determined. Only an Anthropic API key gives an authoritative answer; Bedrock
 * and subscription-only setups return null so agents are never auto-paused
 * against a merely-curated list (see the model-refresh service).
 */
export async function fetchLiveClaudeModels(): Promise<AdapterModel[] | null> {
  if (isBedrockEnv()) return null;
  const apiKey = resolveAnthropicApiKey();
  if (!apiKey) return null;
  return fetchAnthropicModelsFromApi(apiKey);
}

async function loadClaudeModels(opts?: { forceRefresh?: boolean }): Promise<AdapterModel[]> {
  if (isBedrockEnv()) return curatedModels();
  const apiKey = resolveAnthropicApiKey();
  if (!apiKey) return curatedModels();

  const now = Date.now();
  const keyFingerprint = fingerprint(apiKey);
  if (!opts?.forceRefresh && cached && cached.keyFingerprint === keyFingerprint && cached.expiresAt > now) {
    return cached.models;
  }

  const discovered = await fetchAnthropicModelsFromApi(apiKey);
  if (discovered !== null && discovered.length > 0) {
    cached = { keyFingerprint, expiresAt: now + ANTHROPIC_MODELS_CACHE_TTL_MS, models: discovered };
    return discovered;
  }
  if (cached && cached.keyFingerprint === keyFingerprint && cached.models.length > 0) {
    return cached.models;
  }
  return curatedModels();
}

export async function listClaudeModelsWithDiscovery(): Promise<AdapterModel[]> {
  return loadClaudeModels();
}

export async function refreshClaudeModelsWithDiscovery(): Promise<AdapterModel[]> {
  return loadClaudeModels({ forceRefresh: true });
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
 * Return the subset of `candidates` (default: the curated Claude list) that the
 * local CLI can actually run right now. Runs probes with limited concurrency so
 * we don't spawn a CLI per model all at once.
 */
export async function probeClaudeModels(opts?: {
  candidates?: AdapterModel[];
  runner?: ClaudeModelProbeRunner;
  concurrency?: number;
}): Promise<AdapterModel[]> {
  const candidates = opts?.candidates ?? claudeCuratedModels.map((m) => ({ ...m }));
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
}
