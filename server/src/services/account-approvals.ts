/**
 * New accounts are requests until an instance admin approves them.
 *
 * In authenticated mode anyone who can reach the server can make an account
 * on the sign-in page. An account used to get its own Personal company at
 * once, and the owner of a company can make agents that run programs on the
 * server machine, so a new account was close to a way into that machine. Now
 * a new account starts as "pending". It can sign in, but the server refuses it
 * everywhere except the few calls the waiting screen, the invite page and the
 * board-claim page need (middleware/account-approval-guard.ts), and it gets
 * its Personal company only when it is approved.
 *
 * An account skips the wait when:
 * - it existed before this shipped (migration 0109 approved every one);
 * - it claims the board or accepts the bootstrap invite, which is how the
 *   first account on an instance is made, by someone holding the server's own
 *   startup output or command line;
 * - it accepts an invite an instance admin sent, because sending it was the
 *   admin's yes.
 * An invite from anyone else lets a waiting account ask to join that company,
 * but the account still waits for an instance admin.
 *
 * Declining marks the account "declined" rather than deleting it. Deleted, the
 * same address could sign up again at once and be back in the list. The kept
 * row also records who decided and when, and the person's id stays good in
 * any join request they made while waiting instead of pointing at nothing. A
 * declined account cannot sign in (auth/better-auth.ts refuses it a session),
 * and the sessions it already has are ended when it is declined.
 */

import { and, asc, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authSessions, authUsers } from "@paperclipai/db";
import {
  ACCOUNT_APPROVAL_STATUSES,
  type AccountApprovalStatus,
  type AccountRequest,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { ensurePersonalCompanyOnce } from "./personal-companies.js";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The synthetic user a local_trusted install runs as. It is never a request. */
const LOCAL_BOARD_USER_ID = "local-board";

export const ACCOUNT_PENDING_APPROVAL_MESSAGE = "Your account is waiting for an admin to approve it.";
export const ACCOUNT_DECLINED_MESSAGE = "An admin declined this account, so it cannot sign in.";

function asApprovalStatus(value: string | null | undefined): AccountApprovalStatus | null {
  return (ACCOUNT_APPROVAL_STATUSES as readonly string[]).includes(value ?? "")
    ? (value as AccountApprovalStatus)
    : null;
}

/**
 * Where `userId`'s account stands. Null when there is no such account, or the
 * column holds something unknown; callers treat null as not approved.
 */
export async function loadAccountApprovalStatus(
  db: Db | DbTransaction,
  userId: string,
): Promise<AccountApprovalStatus | null> {
  const row = await db
    .select({ approvalStatus: authUsers.approvalStatus })
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .then((rows) => rows[0] ?? null);
  return row ? asApprovalStatus(row.approvalStatus) : null;
}

/**
 * Approves `userId` if, and only if, it is waiting, and returns it. Changes
 * the status alone, so it can run inside a caller's transaction; the caller
 * then makes the Personal company with provisionApprovedAccount once it has
 * committed. Outside a transaction, use approveWaitingAccount.
 */
export async function markWaitingAccountApproved(
  db: Db | DbTransaction,
  userId: string,
  decidedByUserId: string | null,
): Promise<{ id: string; name: string } | null> {
  const now = new Date();
  return db
    .update(authUsers)
    .set({
      approvalStatus: "approved",
      approvalDecidedAt: now,
      approvalDecidedByUserId: decidedByUserId,
      updatedAt: now,
    })
    .where(and(eq(authUsers.id, userId), eq(authUsers.approvalStatus, "pending")))
    .returning({ id: authUsers.id, name: authUsers.name })
    .then((rows) => rows[0] ?? null);
}

/**
 * The Personal company an approved account gets, which a waiting one does not.
 * Never fails the approval: if making it fails, the account's next request
 * makes it instead (middleware/auth.ts).
 */
export async function provisionApprovedAccount(
  db: Db,
  account: { id: string; name: string | null },
): Promise<void> {
  await ensurePersonalCompanyOnce(db, account.id, account.name);
}

/** Lets a waiting account in and makes its Personal company. True when it was waiting. */
export async function approveWaitingAccount(
  db: Db,
  userId: string,
  decidedByUserId: string | null,
): Promise<boolean> {
  const approved = await markWaitingAccountApproved(db, userId, decidedByUserId);
  if (!approved) return false;
  await provisionApprovedAccount(db, approved);
  logger.info({ userId, decidedByUserId }, "account approved");
  return true;
}

export function accountApprovalService(db: Db) {
  return {
    /** The waiting accounts, the longest waiting first. */
    listWaiting: async (): Promise<AccountRequest[]> => {
      const rows = await db
        .select({
          id: authUsers.id,
          name: authUsers.name,
          email: authUsers.email,
          createdAt: authUsers.createdAt,
        })
        .from(authUsers)
        .where(and(eq(authUsers.approvalStatus, "pending"), ne(authUsers.id, LOCAL_BOARD_USER_ID)))
        .orderBy(asc(authUsers.createdAt));
      return rows.map((row) => ({
        id: row.id,
        name: row.name || null,
        email: row.email || null,
        requestedAt: row.createdAt.toISOString(),
      }));
    },

    /**
     * Approves a waiting account. The status the account is left in, so the
     * route can tell a second click (already approved) from a declined
     * account or one that does not exist (null).
     */
    approve: async (
      userId: string,
      decidedByUserId: string | null,
    ): Promise<AccountApprovalStatus | null> => {
      if (await approveWaitingAccount(db, userId, decidedByUserId)) return "approved";
      return loadAccountApprovalStatus(db, userId);
    },

    /** Declines a waiting account and signs it out. The status it is left in, as approve. */
    decline: async (
      userId: string,
      decidedByUserId: string | null,
    ): Promise<AccountApprovalStatus | null> => {
      const now = new Date();
      const declined = await db.transaction(async (tx) => {
        const row = await tx
          .update(authUsers)
          .set({
            approvalStatus: "declined",
            approvalDecidedAt: now,
            approvalDecidedByUserId: decidedByUserId,
            updatedAt: now,
          })
          .where(and(eq(authUsers.id, userId), eq(authUsers.approvalStatus, "pending")))
          .returning({ id: authUsers.id })
          .then((rows) => rows[0] ?? null);
        if (!row) return false;
        // Signed out now, rather than left looking at the waiting screen.
        await tx.delete(authSessions).where(eq(authSessions.userId, userId));
        return true;
      });
      if (declined) {
        logger.info({ userId, decidedByUserId }, "account declined");
        return "declined";
      }
      return loadAccountApprovalStatus(db, userId);
    },
  };
}
