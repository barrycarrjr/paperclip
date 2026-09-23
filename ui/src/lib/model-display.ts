import {
  groupModelsForPicker,
  type ModelLifecycleFields,
  type ModelListEntry,
  type SavedModelState,
} from "@paperclipai/shared";
import type { AvailableModel } from "../api/chat";
import { extractModelName, extractProviderIdWithFallback, formatDraftModelLabel } from "./model-utils";
import { formatDate, formatShortDate } from "./utils";

/**
 * How a model is shown in every model picker: the small tags on a row, the
 * line under a picker about the saved model, and how the list is grouped and
 * searched. Every picker reads these, so a model never looks one way in the
 * agent form and another way in chat.
 */

export type ModelTagKind = "new" | "default" | "retiring" | "unavailable";

export interface ModelTag {
  kind: ModelTagKind;
  /** The words on the tag. */
  label: string;
  /** Longer words, shown on hover. */
  title: string;
}

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Read a release date (`2026-09-22`) or a timestamp. A bare date is read as
 * that day where the reader is, not as midnight UTC, so it never shows as the
 * day before.
 */
export function parseModelDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const dateOnly = DATE_ONLY_RE.exec(value);
  const date = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "Oct 14", with the year added when it is not this year. */
export function formatModelShortDate(value: string | null | undefined, now = new Date()): string | null {
  const date = parseModelDate(value);
  if (!date) return null;
  return date.getFullYear() === now.getFullYear() ? formatShortDate(date) : formatDate(date);
}

/** "Oct 14, 2026". */
export function formatModelLongDate(value: string | null | undefined): string | null {
  const date = parseModelDate(value);
  return date ? formatDate(date) : null;
}

/**
 * The tags a picker row shows for a model, in reading order: New, Default,
 * Retires <date>. A plain current model gets none, and so does an older one,
 * because pickers already fold those under "Older models".
 */
export function modelLifecycleTags(model: ModelLifecycleFields, now = new Date()): ModelTag[] {
  const tags: ModelTag[] = [];
  const status = model.status ?? "current";
  if (model.isNew && status === "current") {
    const released = formatModelLongDate(model.releasedAt);
    tags.push({
      kind: "new",
      label: "New",
      title: released ? `Released ${released}` : "Released in the last 30 days",
    });
  }
  if (model.isDefault) {
    tags.push({ kind: "default", label: "Used by default", title: "The model the provider uses when none is chosen" });
  }
  if (status === "deprecated") {
    const short = formatModelShortDate(model.retiresAt, now);
    const long = formatModelLongDate(model.retiresAt);
    tags.push({
      kind: "retiring",
      label: short ? `Retires ${short}` : "Retiring",
      title: model.notice ?? (long ? `The provider stops offering it on ${long}` : "The provider is retiring it"),
    });
  }
  return tags;
}

/** The tag for a saved model the provider no longer lists. */
export const UNAVAILABLE_MODEL_TAG: ModelTag = {
  kind: "unavailable",
  label: "Not available",
  title: "Not in the models this provider offers right now",
};

export type SavedModelNoticeTone = "info" | "warning" | "danger";

export interface SavedModelNoticeContent<T extends ModelListEntry> {
  tone: SavedModelNoticeTone;
  message: string;
  /** The model to offer instead, when there is one. */
  replacement: T | null;
}

/**
 * The line a picker shows under itself about the saved model: it has been
 * replaced by a newer one, it is retiring, or the provider no longer offers
 * it. Null when there is nothing to say: no model saved, the list has not
 * loaded, or the model is fine.
 */
export function savedModelNotice<T extends ModelListEntry>(
  state: SavedModelState<T>,
  savedId: string,
): SavedModelNoticeContent<T> | null {
  switch (state.kind) {
    case "legacy":
      return {
        tone: "info",
        message: state.replacement
          ? `${state.model.label} has been replaced by ${state.replacement.label}.`
          : `${state.model.label} is an older model.`,
        replacement: state.replacement,
      };
    case "retiring": {
      const date = formatModelLongDate(state.model.retiresAt);
      return {
        tone: "warning",
        message:
          state.model.notice ??
          (date ? `${state.model.label} retires on ${date}.` : `${state.model.label} is being retired.`),
        replacement: state.replacement,
      };
    }
    case "unavailable":
      return {
        tone: "danger",
        message: `${savedId.trim()} is not in the models this provider offers right now.`,
        replacement: state.replacement,
      };
    default:
      return null;
  }
}

/* ---- Picker lists ---- */

export interface ModelPickerEntry extends ModelListEntry {
  /** Muted words after the name, such as "via codex_local". */
  hint?: string;
  /** Shorter name for the row when the group heading already says the rest. */
  shortLabel?: string;
}

export interface ModelPickerGroup<T extends ModelPickerEntry = ModelPickerEntry> {
  key: string;
  /** Heading over the group. Leave out for a plain list. */
  label?: string;
  /** One short line under the heading. */
  description?: string;
  models: readonly T[];
}

export interface ModelPickerSection<T extends ModelPickerEntry = ModelPickerEntry> {
  key: string;
  label?: string;
  description?: string;
  /** Current and retiring models, in the server's order. */
  primary: T[];
  /** Models a newer release has replaced, folded under "Older models". */
  older: T[];
}

function matchesSearch(model: ModelPickerEntry, groupLabel: string | undefined, query: string): boolean {
  return [model.id, model.label, model.shortLabel, model.hint, groupLabel].some(
    (text) => typeof text === "string" && text.toLowerCase().includes(query),
  );
}

/**
 * The picker's rows: each group narrowed to the search, then split into the
 * models worth choosing and the older ones. Order is kept as given, because
 * the server already puts current models first, then retiring, then older.
 * Groups with nothing left after the search are dropped.
 */
export function buildModelPickerSections<T extends ModelPickerEntry>(
  groups: readonly ModelPickerGroup<T>[],
  search = "",
): ModelPickerSection<T>[] {
  const query = search.trim().toLowerCase();
  const sections: ModelPickerSection<T>[] = [];
  for (const group of groups) {
    const models = query ? group.models.filter((m) => matchesSearch(m, group.label, query)) : group.models;
    if (models.length === 0) continue;
    const { primary, older } = groupModelsForPicker(models);
    sections.push({ key: group.key, label: group.label, description: group.description, primary, older });
  }
  return sections;
}

/**
 * Group `provider/model` ids (the OpenCode shape) under one heading per
 * provider, providers in alphabetical order. Each row then shows only the
 * part after the slash.
 */
export function groupModelsByProvider<T extends ModelListEntry>(
  models: readonly T[],
): ModelPickerGroup<T & ModelPickerEntry>[] {
  const byProvider = new Map<string, Array<T & ModelPickerEntry>>();
  for (const model of models) {
    const provider = extractProviderIdWithFallback(model.id);
    const list = byProvider.get(provider) ?? [];
    list.push({ ...model, shortLabel: extractModelName(model.id) });
    byProvider.set(provider, list);
  }
  return [...byProvider.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, list]) => ({ key: provider, label: provider, models: list }));
}

/**
 * A chat model (Clippy, email drafts) as a picker row: the provider's name
 * for it, or else its bare id. Adapter-routed entries are stored as
 * `adapter:<type>:<id>`, so the named replacement is written the same way,
 * or it would never match a row.
 */
export function chatModelEntry(model: AvailableModel): ModelPickerEntry {
  const { provider: _provider, model: id, source, label, replacementId, ...lifecycle } = model;
  const adapterRouted = Boolean(source) && id.startsWith("adapter:");
  return {
    ...lifecycle,
    id,
    label: label ?? formatDraftModelLabel(id),
    ...(replacementId
      ? { replacementId: adapterRouted ? `adapter:${source}:${replacementId}` : replacementId }
      : {}),
  };
}
