/**
 * A name with 's on the end, or just an apostrophe when the name already ends
 * in one.
 *
 * Written down once because company names go into sentences all over the
 * switch messages and the unavailable states, and "Carr Rock Holdings's own
 * Costs" is the kind of thing a person notices immediately and a test never
 * does.
 */
export function possessive(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  return /[sS]$/.test(trimmed) ? `${trimmed}'` : `${trimmed}'s`;
}
