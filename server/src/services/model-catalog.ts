/**
 * Public model catalog: release dates, families, deprecation flags and image
 * support for models from every major provider.
 *
 * Provider tools tell us which models an account can use right now; they do
 * not say when a model was released, which family it belongs to, or whether
 * the provider has flagged it for retirement. This fills that gap from
 * models.dev, an open catalog maintained alongside OpenCode and updated within
 * a day of a release, so nobody has to edit a list in this repo when a model
 * ships or retires.
 *
 * It is enrichment only. Nothing here decides whether a model is available,
 * and every caller copes with no catalog at all: the file is fetched at most
 * daily with an ETag, the last good copy is kept on disk for offline starts,
 * and `PAPERCLIP_MODEL_CATALOG_URL=off` switches it off entirely.
 *
 * @module server/services/model-catalog
 */

import fs from "node:fs/promises";
import path from "node:path";
import { stripModelSnapshotDate } from "@paperclipai/shared";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logger } from "../middleware/logger.js";

export interface CatalogModel {
  id: string;
  name?: string;
  /** e.g. `claude-opus`, `gpt-sol`, `gemini-flash`. */
  family?: string;
  /** YYYY-MM-DD */
  releaseDate?: string;
  /** The catalog's own flag, e.g. `deprecated` or `beta`. */
  status?: string;
  supportsImages?: boolean;
  /**
   * False for models that do not answer in text (image, speech and video
   * generators). They cannot run an agent or a chat, so model lists leave
   * them out. Absent when the catalog does not say.
   */
  outputsText?: boolean;
  effortLevels?: string[];
  contextWindow?: number;
}

export interface ModelCatalog {
  source: string;
  /** Last time the copy was confirmed current (a fresh download or a 304). */
  fetchedAt: string;
  etag?: string;
  /** Provider id (models.dev's: `anthropic`, `openai`, `google` ...) to model id to entry. */
  providers: Record<string, Record<string, CatalogModel>>;
}

const DEFAULT_CATALOG_URL = "https://models.dev/api.json";
/** A copy older than this is re-checked the next time anything reads it. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
/** Never ask the catalog more often than this, however often refresh is pressed. */
const MIN_RECHECK_MS = 60 * 60 * 1000;
const RETRY_WITHOUT_COPY_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;
/** How long a first read waits for a download before answering without one. */
const DEFAULT_FIRST_READ_WAIT_MS = 4_000;

let memory: ModelCatalog | null = null;
let diskLoad: Promise<void> | null = null;
let lastAttemptAt = 0;
let inFlight: Promise<ModelCatalog | null> | null = null;

/** The catalog URL, or null when switched off with `PAPERCLIP_MODEL_CATALOG_URL=off`. */
export function modelCatalogUrl(): string | null {
  const raw = process.env.PAPERCLIP_MODEL_CATALOG_URL?.trim();
  if (raw === undefined || raw === "") return DEFAULT_CATALOG_URL;
  if (/^(off|false|0|no|disabled|none)$/i.test(raw)) return null;
  return raw;
}

export function modelCatalogFilePath(): string {
  return path.resolve(resolvePaperclipInstanceRoot(), "data", "model-catalog.json");
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Reduce the full models.dev payload (about 5 MB) to the few fields Paperclip
 * uses, for every provider. Pure, so it is tested on its own.
 */
export function slimModelsDevPayload(raw: unknown): ModelCatalog["providers"] {
  const providers: ModelCatalog["providers"] = {};
  const root = readRecord(raw);
  if (!root) return providers;
  for (const [providerId, providerValue] of Object.entries(root)) {
    const provider = readRecord(providerValue);
    const models = readRecord(provider?.models);
    if (!models) continue;
    const slim: Record<string, CatalogModel> = {};
    for (const [key, modelValue] of Object.entries(models)) {
      const model = readRecord(modelValue);
      if (!model) continue;
      const id = readString(model.id) ?? key;
      const modalities = readRecord(model.modalities);
      const readModalities = (value: unknown) =>
        Array.isArray(value) ? value.filter((m): m is string => typeof m === "string") : null;
      const inputs = readModalities(modalities?.input);
      const outputs = readModalities(modalities?.output);
      const effort = Array.isArray(model.reasoning_options)
        ? (model.reasoning_options as unknown[])
            .map((option) => readRecord(option))
            .find((option) => option?.type === "effort")
        : undefined;
      const effortLevels = Array.isArray(effort?.values)
        ? (effort!.values as unknown[]).filter((v): v is string => typeof v === "string")
        : undefined;
      const context = readRecord(model.limit)?.context;
      const entry: CatalogModel = { id };
      const name = readString(model.name);
      if (name) entry.name = name;
      const family = readString(model.family);
      if (family) entry.family = family;
      const releaseDate = readString(model.release_date);
      if (releaseDate && /^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) entry.releaseDate = releaseDate;
      const status = readString(model.status);
      if (status) entry.status = status;
      if (inputs) entry.supportsImages = inputs.includes("image");
      if (outputs && outputs.length > 0) entry.outputsText = outputs.includes("text");
      if (effortLevels && effortLevels.length > 0) entry.effortLevels = effortLevels;
      if (typeof context === "number" && context > 0) entry.contextWindow = context;
      slim[id] = entry;
    }
    if (Object.keys(slim).length > 0) providers[providerId] = slim;
  }
  return providers;
}

function isCatalogShape(value: unknown): value is ModelCatalog {
  const record = readRecord(value);
  return Boolean(record && typeof record.fetchedAt === "string" && readRecord(record.providers));
}

async function loadFromDisk(): Promise<ModelCatalog | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(modelCatalogFilePath(), "utf8")) as unknown;
    return isCatalogShape(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeToDisk(catalog: ModelCatalog): Promise<void> {
  const file = modelCatalogFilePath();
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(temp, JSON.stringify(catalog), "utf8");
    await fs.rename(temp, file);
  } catch (err) {
    logger.warn({ err, file }, "could not save the model catalog; it will be downloaded again next time");
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

/** Read the saved copy once; readers that arrive meanwhile wait for the same read. */
function ensureLoaded(): Promise<void> {
  diskLoad ??= loadFromDisk().then((fromDisk) => {
    if (fromDisk && (!memory || fromDisk.fetchedAt > memory.fetchedAt)) memory = fromDisk;
  });
  return diskLoad;
}

function isStale(catalog: ModelCatalog | null, now: number): boolean {
  if (!catalog) return true;
  const fetchedAt = Date.parse(catalog.fetchedAt);
  return !Number.isFinite(fetchedAt) || now - fetchedAt > STALE_AFTER_MS;
}

async function download(url: string, fetchImpl: typeof fetch): Promise<ModelCatalog | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (memory?.etag && memory.source === url) headers["if-none-match"] = memory.etag;
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    if (response.status === 304 && memory) {
      const confirmed: ModelCatalog = { ...memory, fetchedAt: new Date().toISOString() };
      memory = confirmed;
      await writeToDisk(confirmed);
      return confirmed;
    }
    if (!response.ok) {
      logger.warn({ url, status: response.status }, "model catalog download failed; keeping the last good copy");
      return memory;
    }
    const providers = slimModelsDevPayload(await response.json());
    if (Object.keys(providers).length === 0) {
      logger.warn({ url }, "model catalog download had no models; keeping the last good copy");
      return memory;
    }
    const fresh: ModelCatalog = {
      source: url,
      fetchedAt: new Date().toISOString(),
      etag: response.headers.get("etag") ?? undefined,
      providers,
    };
    memory = fresh;
    await writeToDisk(fresh);
    return fresh;
  } catch (err) {
    logger.warn({ err, url }, "model catalog download failed; keeping the last good copy");
    return memory;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Re-check the catalog. Without `force` it only downloads when the copy is
 * over a day old; with `force` (the daily job, a manual refresh) it downloads
 * whenever an hour has passed since the last attempt. Always resolves, to the
 * best copy available.
 */
export async function refreshModelCatalog(
  opts: { force?: boolean; fetchImpl?: typeof fetch; now?: number } = {},
): Promise<ModelCatalog | null> {
  const url = modelCatalogUrl();
  if (!url) return null;
  await ensureLoaded();
  const now = opts.now ?? Date.now();
  if (inFlight) return inFlight;
  const sinceLastAttempt = now - lastAttemptAt;
  if (memory && sinceLastAttempt < MIN_RECHECK_MS) return memory;
  // With no copy at all, a failing download is retried every few minutes
  // rather than on every read, so an offline install is not slowed down.
  if (!memory && sinceLastAttempt < RETRY_WITHOUT_COPY_MS) return null;
  if (!opts.force && !isStale(memory, now)) return memory;
  lastAttemptAt = now;
  inFlight = download(url, opts.fetchImpl ?? fetch).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * The catalog as it stands, or null when there is none (switched off, or
 * never downloaded and the download is slow or failing). A stale copy is
 * returned straight away and re-checked in the background; with no copy at
 * all, the first read waits briefly for the download.
 */
export async function getModelCatalog(
  opts: { waitMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ModelCatalog | null> {
  if (!modelCatalogUrl()) return null;
  await ensureLoaded();
  if (!isStale(memory, Date.now())) return memory;
  // With no copy and a download already under way, answer at once: only the
  // reader that started the download waits for it, so a slow or hanging
  // download does not hold every model list up for seconds each.
  if (!memory && inFlight) return null;
  const refresh = refreshModelCatalog({ fetchImpl: opts.fetchImpl });
  if (memory) return memory;
  const waitMs = opts.waitMs ?? DEFAULT_FIRST_READ_WAIT_MS;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs);
  });
  try {
    return await Promise.race([refresh, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The catalog already in memory, without touching disk or the network: null
 * before anything has read it. For synchronous callers.
 */
export function peekModelCatalog(): ModelCatalog | null {
  return modelCatalogUrl() ? memory : null;
}

const CONTEXT_SUFFIX_RE = /\[[^\]]*\]$/;

/** Look a model up by id, trying it without a `[1m]`-style suffix and without a snapshot date too. */
export function lookupCatalogModel(
  catalog: ModelCatalog | null | undefined,
  provider: string,
  id: string,
): CatalogModel | null {
  const models = catalog?.providers[provider];
  if (!models) return null;
  const bare = id.trim().replace(CONTEXT_SUFFIX_RE, "");
  return models[id] ?? models[bare] ?? models[stripModelSnapshotDate(bare)] ?? null;
}

export function resetModelCatalogForTests(): void {
  memory = null;
  diskLoad = null;
  lastAttemptAt = 0;
  inFlight = null;
}
