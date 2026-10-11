/**
 * @fileoverview A plugin's saved config, cut down to what one caller may see.
 *
 * Plugin config is instance-wide. One email plugin config lists every mailbox
 * for every company, each naming the companies it serves, and company pages
 * read it to find out whether their company has one. So it cannot be kept from
 * people who are not instance admins, but it should not show them another
 * company's accounts either.
 *
 * A config schema marks a company field with `format: "company-id"`: a single
 * id, or the items of a list of them, where "*" means every company. Reading
 * the config against its schema:
 *
 * - a company id the caller cannot see is left out;
 * - a part of the config (a mailbox, an account, a route) that names companies
 *   is kept only when it names one the caller can see, or "*", because only
 *   then does it serve them;
 * - an entry in a list whose company fields are empty serves nobody, and is
 *   left out too;
 * - a company id the schema does not mark is treated the same way, so a plugin
 *   that forgot the format does not show it either, and the same goes for a
 *   setting keyed by a company id.
 *
 * Everything else is left as it is. The config's own top level is always kept.
 */

import type { JsonSchema } from "@paperclipai/shared";

/** A company entry every account is allowed to serve. */
const PORTFOLIO_WIDE = "*";

/** Stands in for a value that has to be left out of its parent. */
const OMIT = Symbol("omit");

type Schema = Record<string, unknown>;

export interface ConfigViewer {
  /** True for a company this caller may see. */
  canSeeCompany: (companyId: string) => boolean;
  /** True for the id of any company, so ids the schema does not mark are found too. */
  isCompanyId: (value: string) => boolean;
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

function visibleValue(
  value: unknown,
  schema: Schema | null,
  viewer: ConfigViewer,
  inList: boolean,
): unknown {
  if (typeof value === "string") {
    if (marksCompanyId(schema)) {
      return value === PORTFOLIO_WIDE || value.length === 0 || viewer.canSeeCompany(value) ? value : OMIT;
    }
    if (viewer.isCompanyId(value)) return viewer.canSeeCompany(value) ? value : OMIT;
    return value;
  }
  if (Array.isArray(value)) {
    const items = itemSchema(schema);
    const kept: unknown[] = [];
    for (const item of value) {
      const visible = visibleValue(item, items, viewer, true);
      if (visible !== OMIT) kept.push(visible);
    }
    return kept;
  }
  if (isPlainObject(value)) {
    const named: string[] = [];
    companiesNamed(value, schema, viewer, named);
    if (named.length > 0 && !servesViewer(named, viewer)) return OMIT;
    if (named.length === 0 && inList && hasCompanyField(schema)) return OMIT;
    return visibleProperties(value, schema, viewer);
  }
  return value;
}

function visibleProperties(
  value: Record<string, unknown>,
  schema: Schema | null,
  viewer: ConfigViewer,
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    // A map keyed by company id.
    if (viewer.isCompanyId(key) && !viewer.canSeeCompany(key)) continue;
    const visible = visibleValue(child, propertySchema(schema, key), viewer, false);
    if (visible !== OMIT) kept[key] = visible;
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
