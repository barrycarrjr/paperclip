/**
 * Things that ship with the software rather than being made by hand.
 *
 * HQ and Personal are the two companies a Paperclip instance is expected to
 * have from the moment it starts: HQ as the place you look across everything,
 * Personal as the place that is only yours. Neither can be deleted, and until
 * now neither was actually created — `is_portfolio_root` was only ever read,
 * never written, so a fresh install had no HQ and every feature that depends
 * on one silently did nothing.
 */

import { eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/**
 * Give a brand-new instance its HQ.
 *
 * Only when there are no companies at all. An instance that already has
 * companies but no portfolio root is not a fresh install — it is somebody's
 * working setup, and picking one of their companies to promote would be a
 * guess with real consequences (HQ can read across every other company).
 * Those are left alone deliberately; promoting one stays a human decision.
 */
export async function ensureHqCompany(db: Db): Promise<{ created: boolean; id: string | null }> {
  const existingRoot = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.isPortfolioRoot, true))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (existingRoot) return { created: false, id: existingRoot.id };

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(companies);
  if (count > 0) {
    logger.info(
      { companyCount: count },
      "no portfolio root, but this instance already has companies — leaving the choice to an operator",
    );
    return { created: false, id: null };
  }

  const created = await db
    .insert(companies)
    .values({
      name: "HQ",
      description: "The view across every company. Ships with Paperclip and cannot be deleted.",
      issuePrefix: "HQ",
      isPortfolioRoot: true,
    })
    .returning({ id: companies.id })
    .then((rows) => rows[0]);

  if (!created) return { created: false, id: null };
  logger.info({ companyId: created.id }, "created HQ for a new instance");
  return { created: true, id: created.id };
}
