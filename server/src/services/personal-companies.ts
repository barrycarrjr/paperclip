/**
 * Personal companies — one per user, never shared.
 *
 * Every other company is a place people work together. Personal is the
 * opposite: it belongs to exactly one person, and nobody else can be let in
 * by any route. Not a membership row, not an invite, not being an instance
 * administrator, not being an agent of the portfolio root. There is no
 * "except" — that is the entire feature, and an exception anywhere is a leak
 * everywhere.
 *
 * That includes deliberately giving up admin recovery: if someone locks
 * themselves out of their own Personal, an administrator cannot look inside
 * to help. A back door that only administrators can walk through is still a
 * back door, and the promise here is that your Personal is yours.
 */

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, companyMemberships } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { logger } from "../middleware/logger.js";

export const PERSONAL_COMPANY_KIND = "personal";

/**
 * Owner lookup for personal companies, kept in memory because the access
 * check runs on effectively every request and is synchronous.
 *
 * There is one row per user, so this stays small. It is refreshed whenever a
 * personal company is created and can be reloaded on demand; a miss is
 * resolved by reloading rather than by assuming the company is not personal,
 * because assuming wrongly would open exactly the hole this file exists to
 * close.
 */
let ownerByCompanyId = new Map<string, string>();
let companyIdByOwner = new Map<string, string>();
let loaded = false;

export async function loadPersonalCompanyIndex(db: Db): Promise<void> {
  const rows = await db
    .select({ id: companies.id, ownerUserId: companies.ownerUserId })
    .from(companies)
    .where(eq(companies.kind, PERSONAL_COMPANY_KIND));
  ownerByCompanyId = new Map(
    rows.filter((r) => r.ownerUserId).map((r) => [r.id, r.ownerUserId as string]),
  );
  companyIdByOwner = new Map(
    rows.filter((r) => r.ownerUserId).map((r) => [r.ownerUserId as string, r.id]),
  );
  loaded = true;
}

/** For tests and for the provisioning path, which knows the answer already. */
export function rememberPersonalCompany(companyId: string, ownerUserId: string): void {
  ownerByCompanyId.set(companyId, ownerUserId);
  companyIdByOwner.set(ownerUserId, companyId);
}

/** This user's personal company, if the index already knows about it. */
export function personalCompanyIdForUser(userId: string): string | null {
  return companyIdByOwner.get(userId) ?? null;
}

/**
 * Make sure `userId` has a Personal, doing nothing at all when the in-memory
 * index already says so. Called on the login path, so the common case has to
 * cost a map lookup rather than a query.
 */
export async function ensurePersonalCompanyOnce(
  db: Db,
  userId: string,
  displayName?: string | null,
): Promise<void> {
  if (companyIdByOwner.has(userId)) return;
  try {
    await ensurePersonalCompany(db, userId, displayName);
  } catch (err) {
    // Never block sign-in over this. The user gets their Personal on the next
    // request instead of a failed login.
    logger.warn({ err, userId }, "could not provision personal company");
  }
}

export function isPersonalCompanyIndexLoaded(): boolean {
  return loaded;
}

/** The owner of `companyId`, or null when it is not a personal company. */
export function personalCompanyOwner(companyId: string): string | null {
  return ownerByCompanyId.get(companyId) ?? null;
}

export function isPersonalCompany(companyId: string): boolean {
  return ownerByCompanyId.has(companyId);
}

/** Every personal company id, so listings can filter them out in one pass. */
export function personalCompanyIds(): ReadonlySet<string> {
  return new Set(ownerByCompanyId.keys());
}

/**
 * Drop other people's personal companies from a list of companies.
 *
 * Every cross-company surface needs this — company pickers, the HQ activity
 * roll-up, the HQ agent roster, portfolio directives. They all exist to look
 * across everything, which is precisely why each of them would otherwise
 * include private companies. One helper so the rule is written once and can
 * be found by searching for it.
 *
 * `viewerUserId` is null for an actor with no user identity (an HQ agent, for
 * instance), in which case no personal company is theirs and all are removed.
 */
export function excludeOthersPersonalCompanies<T extends { id: string }>(
  rows: T[],
  viewerUserId: string | null,
): T[] {
  if (ownerByCompanyId.size === 0) return rows;
  return rows.filter((row) => {
    const owner = ownerByCompanyId.get(row.id);
    return !owner || owner === viewerUserId;
  });
}

/** The user id to judge personal-company ownership against, for a request actor. */
export function viewerUserIdForPersonalCheck(actor: {
  type: string;
  userId?: string | null;
}): string | null {
  return actor.type === "board" || actor.type === "tool_session" ? actor.userId ?? null : null;
}

/**
 * The single gate. Throws unless `userId` is the owner.
 *
 * Called before any other reasoning about access, so that a rule which would
 * otherwise grant entry — portfolio-root read-across, instance admin, an
 * inherited membership — never gets the chance to.
 */
export function assertPersonalCompanyOwner(
  companyId: string,
  userId: string | null | undefined,
): void {
  const owner = ownerByCompanyId.get(companyId);
  if (!owner) return; // Not a personal company; normal rules apply.
  if (!userId || userId !== owner) {
    // Deliberately says nothing about whose it is, or that it is personal at
    // all beyond the fact it exists.
    throw forbidden("This is someone's personal company");
  }
}

/**
 * The personal company belonging to `userId`, creating it if this is their
 * first time. Idempotent: the unique index is the real guarantee, and a
 * concurrent caller that loses the race re-reads instead of failing.
 */
export async function ensurePersonalCompany(
  db: Db,
  userId: string,
  displayName?: string | null,
): Promise<{ id: string; created: boolean }> {
  const existing = await db
    .select({ id: companies.id })
    .from(companies)
    .where(
      and(eq(companies.kind, PERSONAL_COMPANY_KIND), eq(companies.ownerUserId, userId)),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (existing) {
    rememberPersonalCompany(existing.id, userId);
    return { id: existing.id, created: false };
  }

  // Adopt a hand-made "Personal" this user already has to themselves, rather
  // than leaving it beside a new empty one. Instances that predate this
  // feature all have one, full of real work, and a second Personal appearing
  // next to it is worse than useless.
  //
  // Done here rather than in the migration because the migration cannot tell
  // whose it was — it has companies and users but no link between them. By
  // the time someone signs in, we know exactly who is asking.
  const adoptable = await findAdoptablePersonalCompany(db, userId);
  if (adoptable) {
    await db
      .update(companies)
      .set({ kind: PERSONAL_COMPANY_KIND, ownerUserId: userId, updatedAt: new Date() })
      .where(eq(companies.id, adoptable));
    rememberPersonalCompany(adoptable, userId);
    logger.info({ userId, companyId: adoptable }, "adopted existing Personal company");
    return { id: adoptable, created: false };
  }

  try {
    const created = await db
      .insert(companies)
      .values({
        name: "Personal",
        description: displayName ? `${displayName}'s personal workspace` : "Your personal workspace",
        kind: PERSONAL_COMPANY_KIND,
        ownerUserId: userId,
        issuePrefix: await nextPersonalIssuePrefix(db),
      })
      .returning({ id: companies.id })
      .then((rows) => rows[0]);

    if (!created) throw new Error("insert returned no row");

    // A membership row as well as the owner column: the owner column is what
    // grants access, but everything that lists "my companies" reads
    // memberships, and Personal should appear there like anywhere else.
    await db.insert(companyMemberships).values({
      companyId: created.id,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
    });

    rememberPersonalCompany(created.id, userId);
    logger.info({ userId, companyId: created.id }, "provisioned personal company");
    return { id: created.id, created: true };
  } catch (err) {
    // Lost a race against another request for the same user: the unique index
    // did its job. Re-read rather than surfacing a constraint error.
    const raced = await db
      .select({ id: companies.id })
      .from(companies)
      .where(
        and(eq(companies.kind, PERSONAL_COMPANY_KIND), eq(companies.ownerUserId, userId)),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (raced) {
      rememberPersonalCompany(raced.id, userId);
      return { id: raced.id, created: false };
    }
    throw err;
  }
}

/**
 * A pre-existing company named "Personal" that belongs to this user alone,
 * and so can safely become their personal company.
 *
 * Deliberately strict. It must be unclaimed, named Personal, and the user
 * must be its ONLY active human member — if two people can see it, it was a
 * shared company and turning it private would take it away from one of them.
 * When in doubt this returns nothing and the user simply gets a fresh one.
 */
async function findAdoptablePersonalCompany(db: Db, userId: string): Promise<string | null> {
  const candidates = await db
    .select({ id: companies.id })
    .from(companies)
    .where(and(eq(companies.kind, "standard"), sql`lower(${companies.name}) = 'personal'`));
  if (candidates.length === 0) return null;

  for (const candidate of candidates) {
    const members = await db
      .select({ principalId: companyMemberships.principalId })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, candidate.id),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
        ),
      );
    const humans = members.map((m) => m.principalId).filter((id) => id !== LOCAL_BOARD_USER_ID);
    if (humans.length === 1 && humans[0] === userId) return candidate.id;
  }
  return null;
}

/**
 * The synthetic actor a local_trusted install runs as. It is a row in `user`
 * but not a person, so it never counts when deciding whether a company is
 * shared.
 */
const LOCAL_BOARD_USER_ID = "local-board";

/**
 * Issue prefixes are unique across the instance, so every user's Personal
 * needs its own. "ME" for the first, then ME2, ME3…
 */
async function nextPersonalIssuePrefix(db: Db): Promise<string> {
  const taken = new Set(
    (await db.select({ prefix: companies.issuePrefix }).from(companies)).map((r) => r.prefix),
  );
  if (!taken.has("ME")) return "ME";
  for (let n = 2; n < 10_000; n += 1) {
    const candidate = `ME${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error("Could not allocate an issue prefix for a personal company");
}

/**
 * Refuse to let anyone else in. Used by the membership and invite paths.
 * Personal companies reject these outright rather than relying on a
 * permission check further down, so there is no ordering in which a member
 * could be added and then filtered out.
 */
export function assertNotPersonalCompany(companyId: string, action: string): void {
  if (isPersonalCompany(companyId)) {
    throw forbidden(`A personal company is private to one person — cannot ${action}`);
  }
}
