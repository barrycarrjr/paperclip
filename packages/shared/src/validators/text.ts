import { z } from "zod";

export function normalizeEscapedLineBreaks(value: string): string {
  return value
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n");
}

export const multilineTextSchema = z.string().transform(normalizeEscapedLineBreaks);

/**
 * Replace em dashes (U+2014) and en dashes (U+2013) with a comma and a space.
 *
 * House rule: no em or en dash in any persisted or customer-facing text. This
 * is applied at the one point where model-written text enters the database
 * (a drafted plan), so the rule holds without every consumer remembering it.
 * Ordinary hyphens are left alone; they are punctuation people actually type.
 * A dash that already had spaces around it would otherwise leave a doubled
 * space behind, so those are collapsed too.
 */
export function stripDashes(text: string): string {
  return text
    .replace(/\s*[\u2013\u2014]\s*/g, ", ")
    .replace(/ {2,}/g, " ");
}
