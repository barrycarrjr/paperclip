/**
 * The record of an email handed to an agent, and its lifecycle
 * (P5a §3-§4 — docs/plans/2026-09-03-p5a-email-delegation-spec.md).
 *
 * The state rules themselves live in `@paperclipai/shared`'s
 * `email-delegation-state.ts` so the UI and the tests read the same ones.
 * What lives here is everything that needs the database: making a delegation
 * without making a second one for the same email, moving it through its
 * states without a stale write winning, and answering "what happened to this
 * email" later.
 *
 * Company scoping: `companyId` is the authorization boundary used everywhere
 * else in this app, and every read and write here takes it. There is no
 * "find by id" that skips it, deliberately — a delegation names a real
 * customer's message, so a missing company filter would be a cross-company
 * leak rather than a tidiness problem.
 */

import { and, desc, eq, inArray, lt, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueEmailDelegations, issues } from "@paperclipai/db";
import {
  TERMINAL_EMAIL_DELEGATION_STATES,
  checkEmailDelegationTransition,
  isEmailDelegationState,
  type EmailDelegationState,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";

const log = logger.child({ service: "issue-email-delegations" });

/**
 * The partial unique index from migration 0095. Postgres reports it by name
 * on a conflict, which is how a genuine duplicate is told apart from any
 * other constraint failure — catching every 23505 alike would silently
 * swallow real bugs.
 */
const OPEN_SOURCE_CONSTRAINT = "issue_email_delegations_open_source_uq";

export type IssueEmailDelegationRow = typeof issueEmailDelegations.$inferSelect;

export interface CreateEmailDelegationInput {
  issueId: string;
  companyId: string;
  pluginId: string;
  /** The versioned key from `buildEmailHandoffOriginId`. */
  sourceKey: string;
  mailbox: string;
  folder?: string | null;
  messageId?: string | null;
  delegatedByUserId?: string | null;
  delegatedToAgentId?: string | null;
  /** Set only when this delegation follows a handback. */
  previousDelegationId?: string | null;
}

export interface TransitionEmailDelegationInput {
  companyId: string;
  delegationId: string;
  to: EmailDelegationState;
  /** Required when moving to `handed_back`. */
  handedBackReason?: string | null;
  resolutionNote?: string | null;
  /**
   * The version the caller last read. Supplying it makes the write fail
   * rather than overwrite a change someone else made in between (spec §4.3).
   * Omitting it is allowed for server-internal callers that have just read
   * the row in the same breath.
   */
  expectedVersion?: number | null;
}

function isOpenSourceConflict(error: unknown): boolean {
  const err = error as { code?: string; constraint?: string; constraint_name?: string };
  const constraint = err?.constraint ?? err?.constraint_name;
  return err?.code === "23505" && constraint === OPEN_SOURCE_CONSTRAINT;
}

export function issueEmailDelegationService(db: Db) {
  async function findById(companyId: string, delegationId: string) {
    const [row] = await db
      .select()
      .from(issueEmailDelegations)
      .where(
        and(
          eq(issueEmailDelegations.id, delegationId),
          eq(issueEmailDelegations.companyId, companyId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * The delegation currently holding this email, if any.
   *
   * Only an open one counts. A resolved or handed-back delegation is history:
   * the same email can legitimately be handed off again later, and treating
   * an old record as current would block that.
   */
  async function findOpenBySourceKey(companyId: string, sourceKey: string) {
    const [row] = await db
      .select()
      .from(issueEmailDelegations)
      .where(
        and(
          eq(issueEmailDelegations.companyId, companyId),
          eq(issueEmailDelegations.sourceKey, sourceKey),
          notInArray(issueEmailDelegations.status, [...TERMINAL_EMAIL_DELEGATION_STATES]),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** Every delegation for an issue, newest first, including finished ones. */
  async function listForIssue(companyId: string, issueId: string) {
    return db
      .select()
      .from(issueEmailDelegations)
      .where(
        and(
          eq(issueEmailDelegations.companyId, companyId),
          eq(issueEmailDelegations.issueId, issueId),
        ),
      )
      .orderBy(desc(issueEmailDelegations.delegatedAt));
  }

  /**
   * Record a handover.
   *
   * Idempotent on the source email rather than on the issue (spec §4.2): a
   * retried click or a double-fired tool call is a repeat of "hand THIS email
   * over", and keying on the issue id would miss that because the retry
   * creates a second issue first. When an open delegation already exists for
   * the email, that existing one is returned and nothing is written.
   *
   * The database's partial unique index is the actual guard. The read before
   * it is only a fast path: two simultaneous requests both pass the read, and
   * the index decides between them, which is why the conflict is caught and
   * turned back into "here is the one that won" instead of an error.
   */
  async function create(input: CreateEmailDelegationInput): Promise<{
    delegation: IssueEmailDelegationRow;
    created: boolean;
  }> {
    const existing = await findOpenBySourceKey(input.companyId, input.sourceKey);
    if (existing) {
      return { delegation: existing, created: false };
    }

    try {
      const [row] = await db
        .insert(issueEmailDelegations)
        .values({
          issueId: input.issueId,
          companyId: input.companyId,
          pluginId: input.pluginId,
          sourceKey: input.sourceKey,
          mailbox: input.mailbox,
          folder: input.folder ?? null,
          messageId: input.messageId ?? null,
          status: "delegated",
          delegatedByUserId: input.delegatedByUserId ?? null,
          delegatedToAgentId: input.delegatedToAgentId ?? null,
          previousDelegationId: input.previousDelegationId ?? null,
        })
        .returning();
      return { delegation: row, created: true };
    } catch (err) {
      if (isOpenSourceConflict(err)) {
        const winner = await findOpenBySourceKey(input.companyId, input.sourceKey);
        if (winner) {
          log.info(
            { companyId: input.companyId, sourceKey: input.sourceKey, delegationId: winner.id },
            "delegation for this email already existed; reusing it",
          );
          return { delegation: winner, created: false };
        }
      }
      throw err;
    }
  }

  /**
   * Move a delegation to a new state.
   *
   * The version check is what stops a slow "resolve" from quietly undoing a
   * "handed back" that landed while it was in flight (spec §4.3). It is done
   * in the UPDATE's own WHERE clause rather than as a read-then-write, so
   * there is no window between checking and writing.
   */
  async function transition(
    input: TransitionEmailDelegationInput,
  ): Promise<IssueEmailDelegationRow> {
    const current = await findById(input.companyId, input.delegationId);
    if (!current) throw notFound("Delegation not found");

    const check = checkEmailDelegationTransition({
      from: current.status,
      to: input.to,
      handedBackReason: input.handedBackReason,
    });
    if (!check.ok) throw unprocessable(check.reason);

    if (
      typeof input.expectedVersion === "number" &&
      input.expectedVersion !== current.version
    ) {
      throw conflict(
        "This delegation changed while you were looking at it. Reload and try again.",
      );
    }

    const now = new Date();
    const [updated] = await db
      .update(issueEmailDelegations)
      .set({
        status: check.to,
        version: sql`${issueEmailDelegations.version} + 1`,
        updatedAt: now,
        ...(check.to === "acknowledged" && !current.acknowledgedAt
          ? { acknowledgedAt: now }
          : {}),
        ...(check.to === "resolved" ? { resolvedAt: now } : {}),
        ...(input.resolutionNote !== undefined
          ? { resolutionNote: input.resolutionNote }
          : {}),
        ...(check.to === "handed_back"
          ? { handedBackReason: input.handedBackReason?.trim() ?? null }
          : {}),
      })
      .where(
        and(
          eq(issueEmailDelegations.id, input.delegationId),
          eq(issueEmailDelegations.companyId, input.companyId),
          // Guard on the version we validated against, so a concurrent write
          // between the read above and this update loses instead of being
          // overwritten.
          eq(issueEmailDelegations.version, current.version),
        ),
      )
      .returning();

    if (!updated) {
      throw conflict(
        "This delegation changed while you were looking at it. Reload and try again.",
      );
    }
    return updated;
  }

  /**
   * Hand the same email to someone else.
   *
   * Closes the current delegation as `re_delegated` and opens a new one
   * pointing back at it, rather than reassigning the existing row. Keeping
   * the chain is the whole reason this is a table: after two or three rounds,
   * "who had this and what did they say" still has an answer.
   */
  async function reDelegate(input: {
    companyId: string;
    delegationId: string;
    issueId: string;
    delegatedToAgentId?: string | null;
    delegatedByUserId?: string | null;
    expectedVersion?: number | null;
  }): Promise<IssueEmailDelegationRow> {
    const current = await findById(input.companyId, input.delegationId);
    if (!current) throw notFound("Delegation not found");

    await transition({
      companyId: input.companyId,
      delegationId: input.delegationId,
      to: "re_delegated",
      expectedVersion: input.expectedVersion,
    });

    const { delegation } = await create({
      issueId: input.issueId,
      companyId: current.companyId,
      pluginId: current.pluginId,
      sourceKey: current.sourceKey,
      mailbox: current.mailbox,
      folder: current.folder,
      messageId: current.messageId,
      delegatedByUserId: input.delegatedByUserId ?? null,
      delegatedToAgentId: input.delegatedToAgentId ?? null,
      previousDelegationId: current.id,
    });
    return delegation;
  }

  /** Record what happened to the reply, separately from the state change. */
  async function setReplyState(input: {
    companyId: string;
    delegationId: string;
    replyState: "none" | "queued" | "sent" | "failed";
    replyError?: string | null;
  }): Promise<void> {
    await db
      .update(issueEmailDelegations)
      .set({
        replyState: input.replyState,
        replyError: input.replyError ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(issueEmailDelegations.id, input.delegationId),
          eq(issueEmailDelegations.companyId, input.companyId),
        ),
      );
  }

  /**
   * Open delegations that nobody has picked up since `before`.
   *
   * Returned for the attention queue to show (spec §4.5 recommends extending
   * that rather than building a second "things are stuck" surface). Only
   * `delegated` counts as never picked up: once an agent has acknowledged,
   * slowness is the issue's problem to report, not the handover's.
   */
  async function listStale(input: {
    companyId: string;
    before: Date;
    limit?: number;
  }): Promise<IssueEmailDelegationRow[]> {
    return db
      .select()
      .from(issueEmailDelegations)
      .where(
        and(
          eq(issueEmailDelegations.companyId, input.companyId),
          eq(issueEmailDelegations.status, "delegated"),
          lt(issueEmailDelegations.delegatedAt, input.before),
        ),
      )
      .orderBy(issueEmailDelegations.delegatedAt)
      .limit(input.limit ?? 50);
  }

  /**
   * Issues that came from an email but have no delegation row.
   *
   * The spec (§4.1) asks whether issue creation and the delegation write
   * should be one transaction or two steps with a sweep. Two steps, with
   * this: making issue creation fail because a tracking row could not be
   * written would take a reliable action and make it less reliable, and the
   * issue is the thing that actually carries the work. So the delegation is
   * allowed to be missing, and this finds the gaps so they are visible
   * instead of silent, which is the same failure class the wake-failure fix
   * dealt with one layer down.
   */
  async function listIssuesMissingDelegation(input: {
    companyId: string;
    originKind: string;
    limit?: number;
  }): Promise<{ id: string; originId: string | null; createdAt: Date }[]> {
    const rows = await db
      .select({
        id: issues.id,
        originId: issues.originId,
        createdAt: issues.createdAt,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, input.companyId),
          eq(issues.originKind, input.originKind),
          sql`not exists (
            select 1 from ${issueEmailDelegations}
            where ${issueEmailDelegations.issueId} = ${issues.id}
          )`,
        ),
      )
      .orderBy(desc(issues.createdAt))
      .limit(input.limit ?? 100);
    return rows;
  }

  async function listByStatus(input: {
    companyId: string;
    statuses: EmailDelegationState[];
    limit?: number;
  }): Promise<IssueEmailDelegationRow[]> {
    const statuses = input.statuses.filter(isEmailDelegationState);
    if (statuses.length === 0) return [];
    return db
      .select()
      .from(issueEmailDelegations)
      .where(
        and(
          eq(issueEmailDelegations.companyId, input.companyId),
          inArray(issueEmailDelegations.status, statuses),
        ),
      )
      .orderBy(desc(issueEmailDelegations.delegatedAt))
      .limit(input.limit ?? 100);
  }

  return {
    create,
    findById,
    findOpenBySourceKey,
    listForIssue,
    listByStatus,
    listIssuesMissingDelegation,
    listStale,
    reDelegate,
    setReplyState,
    transition,
  };
}

export type IssueEmailDelegationService = ReturnType<typeof issueEmailDelegationService>;
