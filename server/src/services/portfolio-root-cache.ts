// In-process cache for the portfolio-root (HQ) company id.
//
// `companies.isPortfolioRoot` is a singleton flag that flips rarely (manual
// admin operation). Looking it up on every request would be wasteful, so
// the value is cached in module scope and refreshed only when explicitly
// invalidated. Callers that mutate the flag (POST/PATCH on /api/companies)
// must call `invalidatePortfolioRootCache()` after the write.
//
// `undefined` means "not loaded yet", `null` means "loaded, no HQ exists".

import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";

let cached: string | null | undefined = undefined;

export async function getPortfolioRootCompanyId(db: Db): Promise<string | null> {
  if (cached !== undefined) return cached;
  const row = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.isPortfolioRoot, true))
    .then((rows) => rows[0] ?? null);
  cached = row?.id ?? null;
  return cached;
}

export function invalidatePortfolioRootCache(): void {
  cached = undefined;
}

/** Test-only: force a value without hitting the DB. */
export function _setPortfolioRootCacheForTesting(value: string | null | undefined): void {
  cached = value;
}
