/**
 * Model lifecycle fields and the matching every model picker needs.
 *
 * The server works out each model's status from the provider's own list and a
 * public catalog; the UI groups, labels and warns from the same fields. Both
 * sides use the helpers here, so they cannot disagree about whether a saved
 * model is still offered.
 *
 * @module shared/model-lifecycle
 */

/**
 * `current` is offered and recommended, `legacy` still works but a newer
 * release in the same family has replaced it, and `deprecated` has an
 * announced retirement.
 */
export type ModelLifecycleStatus = "current" | "legacy" | "deprecated";

export interface ModelLifecycleFields {
  status?: ModelLifecycleStatus;
  isDefault?: boolean;
  isNew?: boolean;
  /** Release date (YYYY-MM-DD). */
  releasedAt?: string;
  /** When the provider stops serving the model (ISO timestamp). */
  retiresAt?: string;
  /** The model to move to. */
  replacementId?: string;
  /** The provider's own note about the model's lifecycle. */
  notice?: string;
  /** Other ids that mean this same model. */
  aliases?: string[];
  effortLevels?: string[];
  supportsImages?: boolean;
}

export interface ModelListEntry extends ModelLifecycleFields {
  id: string;
  label: string;
}

const CONTEXT_SUFFIX_RE = /\[[^\]]*\]$/;
/**
 * A trailing snapshot date, in Anthropic's `-YYYYMMDD` form or OpenAI's
 * `-YYYY-MM-DD` form. Left in place, the date's digits would read as a very
 * large version number.
 */
const SNAPSHOT_DATE_RE =
  /-(?:20\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])|20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))$/;

/**
 * A model id reduced for comparison: trimmed, lower case, and without a
 * Claude Code context-window suffix such as `[1m]` (the CLI accepts the id
 * either way, so `claude-opus-5-5[1m]` and `claude-opus-5-5` are one model).
 */
export function normalizeModelId(id: string): string {
  return id.trim().toLowerCase().replace(CONTEXT_SUFFIX_RE, "");
}

/**
 * Drop a trailing snapshot date: `claude-haiku-4-5-20251001` becomes
 * `claude-haiku-4-5`, `gpt-5-2025-08-07` becomes `gpt-5`.
 */
export function stripModelSnapshotDate(id: string): string {
  return id.replace(SNAPSHOT_DATE_RE, "");
}

/** True when the id ends in a snapshot date (`-YYYYMMDD` or `-YYYY-MM-DD`). */
export function hasModelSnapshotDate(id: string): boolean {
  return SNAPSHOT_DATE_RE.test(id);
}

function candidateKeys(id: string): string[] {
  const normalized = normalizeModelId(id);
  const undated = stripModelSnapshotDate(normalized);
  return undated === normalized ? [normalized] : [normalized, undated];
}

/**
 * Find a saved model id in a list, matching the id itself, then any alias the
 * provider reported, then the same id without a context suffix or snapshot
 * date. Returns null when nothing in the list means that model.
 */
export function findModelInList<T extends ModelListEntry>(
  models: readonly T[],
  id: string | null | undefined,
): T | null {
  const wanted = typeof id === "string" ? id.trim() : "";
  if (!wanted) return null;
  const exact = models.find((m) => m.id === wanted || m.aliases?.includes(wanted));
  if (exact) return exact;

  const keys = candidateKeys(wanted);
  for (const key of keys) {
    const match = models.find((m) => {
      if (candidateKeys(m.id).includes(key)) return true;
      return (m.aliases ?? []).some((alias) => candidateKeys(alias).includes(key));
    });
    if (match) return match;
  }
  return null;
}

/**
 * The model family a Claude-style id belongs to (`claude-opus`, `claude-sonnet`
 * ...), or null for ids this cannot read. Used only as a fallback when the
 * catalog has no family for the model.
 */
export function guessModelFamily(id: string): string | null {
  const match = /^claude-([a-z]+)-\d/.exec(normalizeModelId(id));
  return match ? `claude-${match[1]}` : null;
}

export type SavedModelState<T extends ModelListEntry> =
  /** No model saved: the adapter default applies, which cannot have gone away. */
  | { kind: "default" }
  /** Nothing to compare against yet (list still loading, or empty). */
  | { kind: "unknown" }
  | { kind: "available"; model: T }
  | { kind: "legacy"; model: T; replacement: T | null }
  | { kind: "retiring"; model: T; replacement: T | null }
  | { kind: "unavailable"; replacement: T | null };

function defaultModel<T extends ModelListEntry>(models: readonly T[]): T | null {
  return (
    models.find((m) => m.isDefault && m.status !== "deprecated") ??
    models.find((m) => (m.status ?? "current") === "current") ??
    null
  );
}

function newestInFamily<T extends ModelListEntry>(models: readonly T[], family: string | null): T | null {
  if (!family) return null;
  return models.find((m) => (m.status ?? "current") === "current" && guessModelFamily(m.id) === family) ?? null;
}

/**
 * Follow a chain of named successors to one that is current: a provider may
 * name a successor that has since been replaced itself (GPT-5.5 names
 * GPT-5.6 Sol, which GPT-6 Sol has replaced). Returns the last model found
 * when the chain ends before a current one, and stops on loops.
 */
function followSuccessors<T extends ModelListEntry>(models: readonly T[], firstId: string | undefined): T | null {
  let found: T | null = null;
  let nextId = firstId;
  const seen = new Set<string>();
  while (nextId && !seen.has(nextId) && seen.size < 10) {
    seen.add(nextId);
    const next = findModelInList(models, nextId);
    if (!next) break;
    found = next;
    if ((next.status ?? "current") === "current") break;
    nextId = next.replacementId;
  }
  return found;
}

/**
 * What a picker should say about a saved model: fine, older, retiring, or no
 * longer offered, with the model worth switching to. The replacement is the
 * provider's named successor (followed on to a current model when the
 * successor has been replaced too), otherwise the newest current model in the
 * same family, otherwise the list's default.
 */
export function describeSavedModel<T extends ModelListEntry>(
  models: readonly T[],
  savedId: string | null | undefined,
): SavedModelState<T> {
  const wanted = typeof savedId === "string" ? savedId.trim() : "";
  if (!wanted) return { kind: "default" };
  if (models.length === 0) return { kind: "unknown" };

  const match = findModelInList(models, wanted);
  const named = (id: string | undefined) => followSuccessors(models, id);
  if (!match) {
    return {
      kind: "unavailable",
      replacement: newestInFamily(models, guessModelFamily(wanted)) ?? defaultModel(models),
    };
  }
  const replacement = named(match.replacementId);
  if (match.status === "deprecated") {
    return { kind: "retiring", model: match, replacement: replacement ?? defaultModel(models) };
  }
  if (match.status === "legacy") {
    return {
      kind: "legacy",
      model: match,
      replacement: replacement ?? newestInFamily(models, guessModelFamily(match.id)) ?? defaultModel(models),
    };
  }
  return { kind: "available", model: match };
}

/**
 * Split a list for a picker: everything worth choosing first (current and
 * retiring models, in the server's order), and older models to fold away.
 */
export function groupModelsForPicker<T extends ModelListEntry>(models: readonly T[]): { primary: T[]; older: T[] } {
  const primary: T[] = [];
  const older: T[] = [];
  for (const model of models) {
    if (model.status === "legacy") older.push(model);
    else primary.push(model);
  }
  return { primary, older };
}
