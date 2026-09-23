/**
 * Turns a provider's raw model list into the list every picker shows: each
 * model marked current, legacy or deprecated, the new ones flagged, older ones
 * given a successor, and everything in a sensible order. Also ranks models for
 * the places that pick one on the user's behalf.
 *
 * Pure: the live list and the catalog come in as arguments, so each rule is
 * tested without a CLI, a network or a clock.
 *
 * @module server/services/model-lifecycle
 */

import { guessModelFamily, hasModelSnapshotDate, stripModelSnapshotDate } from "@paperclipai/shared";
import type { AdapterModel, AdapterModelStatus } from "../adapters/types.js";
import { lookupCatalogModel, type CatalogModel, type ModelCatalog } from "./model-catalog.js";

/** A model as a provider's own tool or API reports it. */
export interface LiveModelEntry {
  id: string;
  label?: string;
  isDefault?: boolean;
  retiresAt?: string;
  replacementId?: string;
  notice?: string;
  aliases?: string[];
  effortLevels?: string[];
  supportsImages?: boolean;
}

export interface BuildModelListInput {
  live: LiveModelEntry[];
  catalog?: ModelCatalog | null;
  /** The catalog's provider id for these models (`anthropic`, `openai`, `google`). */
  catalogProvider?: string;
  /**
   * What to take from the catalog besides enrichment:
   * - `none`: nothing (the live list is complete).
   * - `older`: models the live list leaves out that are older than its newest
   *   model in the same family. For a source that lists only current models
   *   (the Claude CLI picker) while older ones still run.
   * - `all`: the whole provider, for when there is no live source at all.
   */
  catalogAdditions?: "none" | "older" | "all";
  /** Keep the live list's own order for current models (a CLI's picker order) instead of newest first. */
  keepLiveOrder?: boolean;
  /** How to label an id nobody gave a name for. */
  labelFor?: (id: string) => string | undefined;
  now?: Date;
  /** How recent a release must be to count as new. */
  newWithinDays?: number;
}

export interface BuiltModelList {
  models: AdapterModel[];
  /**
   * Catalog models newer than anything the live source offers in their family:
   * the provider's tool must be updated before it can run them.
   */
  needsNewerTool: string[];
}

const DEFAULT_NEW_WITHIN_DAYS = 30;
const LATEST_SUFFIX_RE = /\s*\((?:latest)\)\s*$/i;

interface Working extends AdapterModel {
  family: string | null;
  fromCatalogOnly: boolean;
  liveIndex: number;
}

/** Numeric version parts of an id, snapshot date excluded: `gpt-5.6-sol` gives [5, 6]. */
export function modelVersionParts(id: string): number[] {
  return (stripModelSnapshotDate(id.replace(/\[[^\]]*\]$/, "")).match(/\d+/g) ?? []).map(Number);
}

function compareVersions(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Positive when `a` is newer: by release date when both have one, else by version number. */
export function compareModelRecency(
  a: { id: string; releasedAt?: string },
  b: { id: string; releasedAt?: string },
): number {
  if (a.releasedAt && b.releasedAt && a.releasedAt !== b.releasedAt) {
    return a.releasedAt < b.releasedAt ? -1 : 1;
  }
  return compareVersions(modelVersionParts(a.id), modelVersionParts(b.id));
}

function cleanCatalogName(name: string | undefined): string | undefined {
  return name?.replace(LATEST_SUFFIX_RE, "").trim() || undefined;
}

function addAlias(entry: Working, alias: string | undefined): void {
  if (!alias || alias === entry.id) return;
  entry.aliases = entry.aliases ?? [];
  if (!entry.aliases.includes(alias)) entry.aliases.push(alias);
}

function applyCatalog(entry: Working, info: CatalogModel | null): void {
  if (!info) return;
  entry.family = info.family ?? entry.family;
  if (!entry.releasedAt && info.releaseDate) entry.releasedAt = info.releaseDate;
  if (entry.supportsImages === undefined && info.supportsImages !== undefined) entry.supportsImages = info.supportsImages;
  if (!entry.effortLevels && info.effortLevels) entry.effortLevels = info.effortLevels;
  if (info.status === "deprecated" && entry.status !== "deprecated") entry.status = "deprecated";
}

export function buildModelList(input: BuildModelListInput): BuiltModelList {
  const catalogModels = input.catalogProvider ? input.catalog?.providers[input.catalogProvider] ?? null : null;
  const lookup = (id: string) =>
    input.catalogProvider ? lookupCatalogModel(input.catalog, input.catalogProvider, id) : null;
  const labelFor = (id: string, liveLabel?: string): string => {
    if (liveLabel && liveLabel !== id) return liveLabel;
    return cleanCatalogName(lookup(id)?.name) ?? input.labelFor?.(id) ?? liveLabel ?? id;
  };

  // 1. The live list, one entry per model, with dated snapshots folded into
  // the undated id whenever that id is known too.
  const byId = new Map<string, Working>();
  const knownUndated = new Set<string>([
    ...input.live.map((m) => m.id),
    ...Object.keys(catalogModels ?? {}),
  ]);
  input.live.forEach((live, index) => {
    const raw = live.id.trim();
    if (!raw) return;
    const undated = stripModelSnapshotDate(raw);
    const id = hasModelSnapshotDate(raw) && knownUndated.has(undated) ? undated : raw;
    let entry = byId.get(id);
    if (!entry) {
      entry = { id, label: labelFor(id, live.label), family: null, fromCatalogOnly: false, liveIndex: index };
      byId.set(id, entry);
    }
    addAlias(entry, raw);
    for (const alias of live.aliases ?? []) addAlias(entry, alias);
    if (live.isDefault) entry.isDefault = true;
    if (live.retiresAt) entry.retiresAt = live.retiresAt;
    if (live.replacementId) entry.replacementId = live.replacementId;
    if (live.notice) entry.notice = live.notice;
    if (live.effortLevels) entry.effortLevels = live.effortLevels;
    if (live.supportsImages !== undefined) entry.supportsImages = live.supportsImages;
    if (live.retiresAt || live.replacementId) entry.status = "deprecated";
  });
  for (const entry of [...byId.values()]) {
    const info = lookup(entry.id);
    // An image, speech or video generator cannot run an agent or a chat, and
    // left in, it would count as the newest member of a text model's family
    // (Gemini 3 Pro Image would "replace" Gemini 3.1 Pro).
    if (info?.outputsText === false) {
      byId.delete(entry.id);
      continue;
    }
    applyCatalog(entry, info);
    entry.family = entry.family ?? guessModelFamily(entry.id);
  }

  // 2. Models the catalog knows that the live list does not show.
  const needsNewerTool: string[] = [];
  const additions = input.catalogAdditions ?? "none";
  if (catalogModels && additions !== "none") {
    const liveEntries = [...byId.values()];
    const matchesLive = (id: string) =>
      byId.has(id) || liveEntries.some((e) => e.aliases?.includes(id) || stripModelSnapshotDate(id) === e.id);
    for (const info of Object.values(catalogModels)) {
      if (info.outputsText === false || matchesLive(info.id)) continue;
      // A dated snapshot of an id the catalog also lists under its alias is the same model.
      if (hasModelSnapshotDate(info.id) && catalogModels[stripModelSnapshotDate(info.id)]) continue;
      const family = info.family ?? guessModelFamily(info.id);
      const candidate = { id: info.id, releasedAt: info.releaseDate };
      if (additions === "older") {
        const sameFamily = liveEntries.filter((e) => e.family && e.family === family);
        if (sameFamily.length === 0) continue;
        const newestLive = sameFamily.reduce((best, e) => (compareModelRecency(e, best) > 0 ? e : best));
        const order = compareModelRecency(candidate, newestLive);
        if (order > 0) {
          needsNewerTool.push(info.id);
          continue;
        }
        if (order === 0) continue;
      }
      const entry: Working = {
        id: info.id,
        label: labelFor(info.id),
        family,
        fromCatalogOnly: additions === "older",
        liveIndex: Number.MAX_SAFE_INTEGER,
      };
      applyCatalog(entry, info);
      if (additions === "older" && entry.status !== "deprecated") entry.status = "legacy";
      byId.set(entry.id, entry);
    }
  }

  // 3. Legacy by family: a newer release of the same family is on the list.
  const all = [...byId.values()];
  for (const entry of all) {
    if (entry.status) continue;
    if (entry.isDefault || !entry.family) {
      entry.status = "current";
      continue;
    }
    const superseded = all.some(
      (other) =>
        other !== entry &&
        other.family === entry.family &&
        other.status !== "deprecated" &&
        !other.fromCatalogOnly &&
        compareModelRecency(other, entry) > 0,
    );
    entry.status = superseded ? "legacy" : "current";
  }

  // 4. Successors and "new" flags.
  const now = input.now ?? new Date();
  const newCutoff = new Date(now.getTime() - (input.newWithinDays ?? DEFAULT_NEW_WITHIN_DAYS) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  for (const entry of all) {
    if (entry.status !== "current" && !entry.replacementId && entry.family) {
      const successor = all
        .filter((other) => other.status === "current" && other.family === entry.family)
        .sort((a, b) => compareModelRecency(b, a))[0];
      if (successor) entry.replacementId = successor.id;
    }
    if (entry.status === "current" && entry.releasedAt && entry.releasedAt >= newCutoff) entry.isNew = true;
  }

  // 5. Order: current, then retiring, then older; current in the tool's own
  // order when asked, otherwise newest first.
  const bucket: Record<AdapterModelStatus, number> = { current: 0, deprecated: 1, legacy: 2 };
  all.sort((a, b) => {
    const byBucket = bucket[a.status ?? "current"] - bucket[b.status ?? "current"];
    if (byBucket !== 0) return byBucket;
    if (input.keepLiveOrder && a.status === "current" && a.liveIndex !== b.liveIndex) return a.liveIndex - b.liveIndex;
    // Version numbers only compare within a family: across families the
    // digits mean different things (`mistral:7b` is a size, not a version).
    if ((a.releasedAt && b.releasedAt) || (a.family && a.family === b.family)) {
      const byRecency = compareModelRecency(b, a);
      if (byRecency !== 0) return byRecency;
    }
    if (a.liveIndex !== b.liveIndex) return a.liveIndex - b.liveIndex;
    return a.id.localeCompare(b.id, "en", { numeric: true });
  });

  const models = all.map(({ family: _family, fromCatalogOnly: _fromCatalogOnly, liveIndex: _liveIndex, ...model }) => {
    const out: AdapterModel = { id: model.id, label: model.label };
    for (const [key, value] of Object.entries(model)) {
      if (key === "id" || key === "label" || value === undefined) continue;
      if (Array.isArray(value) && value.length === 0) continue;
      (out as unknown as Record<string, unknown>)[key] = value;
    }
    return out;
  });
  return { models, needsNewerTool };
}

// ---------------------------------------------------------------------------
// Ranking, for the places that pick a model without asking.
// ---------------------------------------------------------------------------

export interface RankableModel {
  /** The model id itself (for adapter-routed chat entries, the decoded id). */
  id: string;
  status?: AdapterModelStatus;
  isDefault?: boolean;
  releasedAt?: string;
  /** Chat provider name: `anthropic`, `openai`, `gemini`, `ollama`, `adapter`. */
  provider?: string;
  /** Adapter type, for adapter-routed entries. */
  source?: string;
}

/**
 * How strongly a model family is preferred for a default. Claude first, as
 * before; within Claude, Opus (the CLI's own recommended default) ahead of
 * Fable, then Sonnet, then Haiku.
 */
export function modelFamilyTier(id: string): number {
  const lower = id.toLowerCase();
  if (lower.includes("claude") || /(^|\/)(opus|fable|sonnet|haiku)\b/.test(lower)) {
    if (lower.includes("opus")) return 200;
    if (lower.includes("fable")) return 195;
    if (lower.includes("sonnet")) return 180;
    return 160;
  }
  const small = /(mini|nano|lite)\b/.test(lower) ? 5 : 0;
  // OpenAI's `-pro` models answer only through the Responses API, which the
  // chat provider does not use, so they never make a good default.
  const responsesOnly = /-pro\b/.test(lower) ? 10 : 0;
  if (/(^|\/)gpt-/.test(lower)) return 140 - small - responsesOnly;
  if (/(^|\/)o\d/.test(lower)) return 110 - small - responsesOnly;
  if (lower.includes("gemini")) return (lower.includes("pro") ? 95 : 90) - small;
  if (lower.includes("qwen") && lower.includes("coder")) return 60;
  if (lower.includes("llama")) return 50;
  if (lower.includes("deepseek") || lower.includes("mistral") || lower.includes("qwen")) return 45;
  return 20;
}

const STATUS_RANK: Record<AdapterModelStatus, number> = { current: 2, deprecated: 1, legacy: 0 };

function routingTier(model: RankableModel, prefer: "cli" | "native"): number {
  if (prefer === "native") return model.provider === "adapter" ? 0 : 1;
  const isAdapter = model.provider === "adapter";
  if (isAdapter && model.source === "claude_local") return 6;
  if (isAdapter && model.source === "codex_local") return 5;
  if (isAdapter && model.source === "gemini_local") return 4;
  if (model.provider === "anthropic") return 3;
  if (isAdapter || model.provider === "openai") return 2;
  return 1;
}

/**
 * Order models best-first for a default pick: family, then current over
 * retiring over older, then the provider's own default, then newest, then
 * routing. Routing comes last on purpose, so an older model is never chosen
 * just because it is reachable through a preferred route.
 */
export function rankModelsForDefault<T extends RankableModel>(
  models: readonly T[],
  opts: { prefer?: "cli" | "native" } = {},
): T[] {
  const prefer = opts.prefer ?? "cli";
  return [...models].sort((a, b) => {
    const family = modelFamilyTier(b.id) - modelFamilyTier(a.id);
    if (family !== 0) return family;
    const status = STATUS_RANK[b.status ?? "current"] - STATUS_RANK[a.status ?? "current"];
    if (status !== 0) return status;
    const byDefault = Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault));
    if (byDefault !== 0) return byDefault;
    const recency = compareModelRecency(b, a);
    if (recency !== 0) return recency;
    return routingTier(b, prefer) - routingTier(a, prefer);
  });
}
