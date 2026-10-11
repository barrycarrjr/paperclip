const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_DIGITS = /^[0-9a-f]{32}$/;

/**
 * A uuid in the one form Postgres gives it back: lower case, with hyphens in
 * the 8-4-4-4-12 places.
 *
 * Postgres also reads a uuid written in capitals, in braces, without hyphens,
 * or with a hyphen after any group of four digits, as the same value. A plain
 * string comparison does not. So an id from a request goes through this before
 * it is looked up in anything filled from the database where a miss lets the
 * caller through, such as the Personal company index. Otherwise the same
 * company gets past the check under another spelling.
 *
 * Anything that is not a uuid comes back as it was.
 */
export function canonicalUuid(value: string): string {
  // Request values are not always strings at run time. Those, and ids already
  // in this form (nearly all of them), come back untouched without any work.
  if (typeof value !== "string" || CANONICAL_UUID.test(value)) return value;
  const digits = value.replace(/[{}-]/g, "").toLowerCase();
  if (!UUID_DIGITS.test(digits)) return value;
  return [
    digits.slice(0, 8),
    digits.slice(8, 12),
    digits.slice(12, 16),
    digits.slice(16, 20),
    digits.slice(20),
  ].join("-");
}
