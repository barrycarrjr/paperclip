/**
 * @fileoverview A plugin's saved config, cut down to what one caller may see,
 * and a save of such a copy put back together with the parts it left out.
 *
 * Plugin config is instance-wide. One email plugin config lists every mailbox
 * for every company, each naming the companies it serves, and company pages
 * read it to find out whether their company has one. So it cannot be kept from
 * people who are not instance admins, but it should not show them another
 * company's accounts either, and it should not show anyone what is inside
 * someone else's Personal company.
 *
 * A config schema marks a company field with `format: "company-id"`: a single
 * id, or the items of a list of them, where "*" means every company. Reading
 * the config against its schema:
 *
 * - a company id the caller cannot see is left out;
 * - a part of the config (a mailbox, an account, a route) that names companies
 *   is kept only when it names one the caller can see, or "*", because only
 *   then does it serve them;
 * - an entry in a list whose company fields are empty serves nobody yet, and is
 *   left out too, except for instance admins, who are setting it up;
 * - a company id the schema does not mark is treated the same way, so a plugin
 *   that forgot the format does not show it either, and the same goes for a
 *   setting keyed by a company id.
 *
 * Everything else is left as it is. The config's own top level is always kept.
 *
 * Saving a copy as it is would delete everything left out of it, so
 * `keepUnseenParts` puts those parts back:
 *
 * - a setting, list entry or company id the copy left out goes back where it was;
 * - an entry the copy showed without some of its parts gets them back. It is
 *   found again by its `key` or `id`, or, when it has neither, by being
 *   unchanged;
 * - an entry the copy showed and the saver removed goes, with the parts the copy
 *   left out of it, because the saver could see the entry itself;
 * - anything that cannot be put back for certain refuses the save, rather than
 *   being guessed at.
 */

import type { JsonSchema } from "@paperclipai/shared";
import { conflict } from "../errors.js";

/** A company entry every account is allowed to serve. */
const PORTFOLIO_WIDE = "*";

/** Fields that name an entry in a list, in the order they are tried. */
const ENTRY_NAME_FIELDS = ["key", "id"] as const;

const SAVE_WOULD_REMOVE_UNSEEN =
  "Saving this would remove settings for companies you cannot see. Reload the page and try again.";

type Schema = Record<string, unknown>;

export interface ConfigViewer {
  /** True for a company this caller may see. */
  canSeeCompany: (companyId: string) => boolean;
  /** True for the id of any company, so ids the schema does not mark are found too. */
  isCompanyId: (value: string) => boolean;
  /** Whether list entries not yet given any company are shown. */
  seesUnassigned: boolean;
}

function asSchema(value: unknown): Schema | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Schema) : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The schema and every schema it combines, so a field declared under allOf, anyOf or oneOf is found. */
function variants(schema: Schema | null): Schema[] {
  if (!schema) return [];
  const all = [schema];
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    const list = schema[key];
    if (Array.isArray(list)) {
      for (const entry of list) all.push(...variants(asSchema(entry)));
    }
  }
  return all;
}

function marksCompanyId(schema: Schema | null): boolean {
  return variants(schema).some((variant) => variant.format === "company-id");
}

function propertySchema(schema: Schema | null, key: string): Schema | null {
  const all = variants(schema);
  for (const variant of all) {
    const declared = asSchema(asSchema(variant.properties)?.[key]);
    if (declared) return declared;
  }
  for (const variant of all) {
    const extra = asSchema(variant.additionalProperties);
    if (extra) return extra;
  }
  return null;
}

function itemSchema(schema: Schema | null): Schema | null {
  for (const variant of variants(schema)) {
    const items = asSchema(variant.items);
    if (items) return items;
  }
  return null;
}

/** Only a schema-marked top-level allowedCompanies list controls UI discovery. */
export function pluginDeclaresCompanyAllowList(schema: JsonSchema | null | undefined): boolean {
  return variants(asSchema(schema)).some((variant) =>
    marksCompanyId(itemSchema(asSchema(asSchema(variant.properties)?.allowedCompanies))),
  );
}

/** True when the schema, or anything below it, marks a company id. */
function hasCompanyField(schema: Schema | null): boolean {
  return variants(schema).some((variant) => {
    if (variant.format === "company-id") return true;
    const properties = asSchema(variant.properties);
    if (properties && Object.values(properties).some((child) => hasCompanyField(asSchema(child)))) {
      return true;
    }
    return hasCompanyField(asSchema(variant.items)) || hasCompanyField(asSchema(variant.additionalProperties));
  });
}

/** Every company a value names, "*" included where the schema marks a company field. */
function companiesNamed(value: unknown, schema: Schema | null, viewer: ConfigViewer, named: string[]): void {
  if (typeof value === "string") {
    if ((marksCompanyId(schema) && value.length > 0) || viewer.isCompanyId(value)) named.push(value);
    return;
  }
  if (Array.isArray(value)) {
    const items = itemSchema(schema);
    for (const item of value) companiesNamed(item, items, viewer, named);
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      companiesNamed(child, propertySchema(schema, key), viewer, named);
    }
  }
}

function servesViewer(named: string[], viewer: ConfigViewer): boolean {
  return named.some((companyId) => companyId === PORTFOLIO_WIDE || viewer.canSeeCompany(companyId));
}

/** True when `value`, as a whole, is not for this viewer. */
function isHidden(value: unknown, schema: Schema | null, viewer: ConfigViewer, inList: boolean): boolean {
  if (typeof value === "string") {
    if (marksCompanyId(schema)) {
      return !(value === PORTFOLIO_WIDE || value.length === 0 || viewer.canSeeCompany(value));
    }
    return viewer.isCompanyId(value) && !viewer.canSeeCompany(value);
  }
  if (isPlainObject(value)) {
    const named: string[] = [];
    companiesNamed(value, schema, viewer, named);
    if (named.length > 0) return !servesViewer(named, viewer);
    return inList && !viewer.seesUnassigned && hasCompanyField(schema);
  }
  return false;
}

/** A setting keyed by a company id the viewer cannot see. */
function isHiddenKey(key: string, viewer: ConfigViewer): boolean {
  return viewer.isCompanyId(key) && !viewer.canSeeCompany(key);
}

/** `value`, which is itself for this viewer, without the parts below it that are not. */
function visibleValue(value: unknown, schema: Schema | null, viewer: ConfigViewer): unknown {
  if (Array.isArray(value)) {
    const items = itemSchema(schema);
    return value
      .filter((item) => !isHidden(item, items, viewer, true))
      .map((item) => visibleValue(item, items, viewer));
  }
  if (isPlainObject(value)) return visibleProperties(value, schema, viewer);
  return value;
}

function visibleProperties(
  value: Record<string, unknown>,
  schema: Schema | null,
  viewer: ConfigViewer,
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const childSchema = propertySchema(schema, key);
    if (isHiddenKey(key, viewer) || isHidden(child, childSchema, viewer, false)) continue;
    kept[key] = visibleValue(child, childSchema, viewer);
  }
  return kept;
}

/**
 * `configJson` as `viewer` may see it. The input is not changed.
 */
export function pluginConfigVisibleTo(
  configJson: Record<string, unknown>,
  schema: JsonSchema | null | undefined,
  viewer: ConfigViewer,
): Record<string, unknown> {
  return visibleProperties(configJson, asSchema(schema ?? null), viewer);
}

/** JSON with object keys in a fixed order, so two copies compare equal whatever order they were built in. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    isPlainObject(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  );
}

/** True when some part below `value` is not for this viewer. */
function hasHiddenPart(value: unknown, schema: Schema | null, viewer: ConfigViewer): boolean {
  return canonical(visibleValue(value, schema, viewer)) !== canonical(value);
}

function entryName(entry: Record<string, unknown>): { field: string; value: string } | null {
  for (const field of ENTRY_NAME_FIELDS) {
    const value = entry[field];
    if (typeof value === "string" && value.length > 0) return { field, value };
  }
  return null;
}

/**
 * Where a stored entry the copy showed in part is in the saved list, or null
 * when the saver removed it.
 */
function findEntry(
  storedEntry: Record<string, unknown>,
  submitted: unknown[],
  items: Schema | null,
  viewer: ConfigViewer,
  taken: Set<number>,
): number | null {
  const name = entryName(storedEntry);
  if (name) {
    const found = submitted.flatMap((entry, at) =>
      !taken.has(at) && isPlainObject(entry) && entry[name.field] === name.value ? [at] : [],
    );
    if (found.length > 1) throw conflict(`Two entries use the ${name.field} "${name.value}". Give each its own.`);
    return found[0] ?? null;
  }
  // Nothing names it, so it can only be found again unchanged.
  const shown = canonical(visibleValue(storedEntry, items, viewer));
  const at = submitted.findIndex((entry, index) => !taken.has(index) && canonical(entry) === shown);
  if (at < 0) throw conflict(SAVE_WOULD_REMOVE_UNSEEN);
  return at;
}

function mergeValue(stored: unknown, submitted: unknown, schema: Schema | null, viewer: ConfigViewer): unknown {
  if (Array.isArray(stored)) {
    if (!Array.isArray(submitted)) throw conflict(SAVE_WOULD_REMOVE_UNSEEN);
    return mergeList(stored, submitted, itemSchema(schema), viewer);
  }
  if (isPlainObject(stored)) {
    if (!isPlainObject(submitted)) throw conflict(SAVE_WOULD_REMOVE_UNSEEN);
    return mergeProperties(stored, submitted, schema, viewer);
  }
  return submitted;
}

function mergeProperties(
  stored: Record<string, unknown>,
  submitted: Record<string, unknown>,
  schema: Schema | null,
  viewer: ConfigViewer,
): Record<string, unknown> {
  const merged = { ...submitted };
  for (const [key, storedChild] of Object.entries(stored)) {
    const childSchema = propertySchema(schema, key);
    if (isHiddenKey(key, viewer) || isHidden(storedChild, childSchema, viewer, false)) {
      // Never shown, so whatever the copy holds here is not a change to it.
      merged[key] = storedChild;
    } else if (key in submitted && hasHiddenPart(storedChild, childSchema, viewer)) {
      merged[key] = mergeValue(storedChild, submitted[key], childSchema, viewer);
    }
    // Otherwise the copy showed all of it, so the copy decides, removal included.
  }
  return merged;
}

function mergeList(
  stored: unknown[],
  submitted: unknown[],
  items: Schema | null,
  viewer: ConfigViewer,
): unknown[] {
  const merged = [...submitted];
  const taken = new Set<number>();
  const putBack: Array<{ index: number; value: unknown }> = [];
  const shownNames = new Set<string>();

  stored.forEach((storedEntry, index) => {
    if (isHidden(storedEntry, items, viewer, true)) {
      putBack.push({ index, value: storedEntry });
      return;
    }
    if (!isPlainObject(storedEntry)) return;
    const name = entryName(storedEntry);
    if (name) shownNames.add(`${name.field}:${name.value}`);
    if (!hasHiddenPart(storedEntry, items, viewer)) return;
    const at = findEntry(storedEntry, submitted, items, viewer, taken);
    if (at === null) return;
    taken.add(at);
    merged[at] = mergeValue(storedEntry, submitted[at], items, viewer);
  });

  // Back where they were, as near as the saver's own additions and removals allow.
  for (const { index, value } of putBack) {
    if (typeof value === "string" && merged.includes(value)) continue;
    if (isPlainObject(value)) {
      // A name the saver has just given an entry of their own would then point at two.
      const name = entryName(value);
      const clashes =
        name !== null &&
        !shownNames.has(`${name.field}:${name.value}`) &&
        submitted.some((entry) => isPlainObject(entry) && entry[name.field] === name.value);
      if (clashes) {
        throw conflict(`An entry you cannot see already uses the ${name.field} "${name.value}". Choose another.`);
      }
    }
    merged.splice(Math.min(index, merged.length), 0, value);
  }
  return merged;
}

/**
 * `submitted`, a saved copy of `stored` as `viewer` was given it, with every
 * part of `stored` the copy left out put back. Throws a 409 when a part cannot
 * be put back for certain.
 */
export function keepUnseenParts(
  stored: Record<string, unknown>,
  submitted: Record<string, unknown>,
  schema: JsonSchema | null | undefined,
  viewer: ConfigViewer,
): Record<string, unknown> {
  return mergeProperties(stored, submitted, asSchema(schema ?? null), viewer);
}
