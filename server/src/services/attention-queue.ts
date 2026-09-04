import { and, desc, eq, inArray, isNull, lt, not } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  budgetIncidents,
  heartbeatRuns,
  issueEmailDelegations,
  issues,
  joinRequests,
} from "@paperclipai/db";
import {
  approvalLabel,
  attentionSnoozeKey,
  describeRunFailureCause,
  isSingleCauseFailure,
  type AttentionKind,
  type AttentionRow,
} from "@paperclipai/shared";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import { issueService } from "./issues.js";
import { collapseDuplicatePendingHumanJoinRequests } from "../lib/join-request-dedupe.js";

/**
 * The attention queue: one server-side answer to "what is blocked on the
 * operator right now". Every surface renders these rows; none computes its
 * own list. See packages/shared/src/types/attention.ts for the row model.
 *
 * Two rules the producers below all follow:
 * 1. A row exists only when a decision ONLY a human can make is open. Work
 *    the system can still finish itself (a run with a retry scheduled, a
 *    question addressed to an agent reviewer) is not a row.
 * 2. One row per PROBLEM, not per event. Repeats raise `count`.
 */

const ACTIONABLE_APPROVAL_STATUSES = ["pending", "revision_requested"];
const FAILED_RUN_STATUSES = ["failed", "timed_out"];
/** How far back to look for still-unaddressed run failures. */
const RUN_FAILURE_LOOKBACK = 400;

/**
 * How long a handed-over email may sit untouched before it needs a person.
 *
 * An hour, because agents wake on their own schedule and a few minutes of
 * delay is normal operation, not a problem worth interrupting anyone about.
 */
export const STALE_EMAIL_HANDOFF_AFTER_MS = 60 * 60 * 1000;

function ms(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function truncate(value: string, max = 120): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/** "3 pieces of work stalled, 41 attempts" - the size of one known problem. */
function describeStalledWork(group: { failures: number; stalledWork: number }): string {
  const work =
    group.stalledWork > 1 ? `${group.stalledWork} pieces of work stalled` : "Work stalled";
  const attempts = group.failures > 1 ? `${group.failures} attempts, all the same` : "1 attempt";
  return `${work}, ${attempts}`;
}

export interface AttentionQueueActor {
  /** Board user id, when a specific person is viewing. */
  userId: string | null;
  /** Whether this actor may act on join requests for the company. */
  canApproveJoins: boolean;
  /**
   * This person's inbox dismissals, keyed by item key, valued by when they
   * dismissed it. Dismissing is per-person and always was; it lives here so
   * that hiding something hides it on every surface at once instead of only
   * lowering a badge while the item stays on the Brief.
   */
  dismissedAtByKey?: ReadonlyMap<string, number>;
  /** Keys this person has put away, valued by when they come back. */
  snoozedUntilByKey?: ReadonlyMap<string, number>;
}

/**
 * A snooze holds until its time is up, whatever happens to the item in the
 * meantime. That is the difference from a dismissal, and it is deliberate:
 * "not until tomorrow" is a decision about the operator's day, not about the
 * item, so an edit to a field must not drag it straight back.
 */
export function isAttentionRowSnoozed(
  row: AttentionRow,
  snoozedUntilByKey: ReadonlyMap<string, number> | undefined,
  nowMs: number,
): boolean {
  if (!snoozedUntilByKey?.size) return false;
  const until = snoozedUntilByKey.get(attentionSnoozeKey(row));
  return until !== undefined && until > nowMs;
}

/** What one company's queue came back with, and what it held back. */
export interface AttentionQueueResult {
  rows: AttentionRow[];
  /** Rows that have gone quiet and are no longer shown by default. */
  setAside: number;
}

/**
 * How long a failure can go without happening again before it stops counting
 * as something waiting on you.
 *
 * Two weeks. Agents here run at least daily, so a problem that has not
 * recurred in a fortnight is not a problem anyone is still hitting.
 */
export const RUN_FAILURE_GOES_QUIET_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Has this row stopped being a decision and become history?
 *
 * Only run failures can. Every other kind describes something that is STILL
 * TRUE right now - an approval really is still unapproved, an agent really is
 * still stuck on its question, a budget really is still capped - and age makes
 * those more pressing, not less. A run failure is different: it describes an
 * event that already finished. If the same work has not failed again in a
 * fortnight, nothing is retrying it and nobody is going to.
 *
 * On the instance this was written for, two rows had been sitting in "Awaiting
 * your tap" since the 31st of May, describing work that stopped being attempted
 * the same day. They were not decisions. They were sediment, and they sat next
 * to a live row about the same agent failing forty-three times this week.
 *
 * Set aside, never deleted: the count travels with the response and the rows
 * come back on request.
 */
export function isAttentionRowSetAside(row: AttentionRow, nowMs: number): boolean {
  if (row.kind !== "run_failure") return false;
  return nowMs - row.updatedAtMs > RUN_FAILURE_GOES_QUIET_AFTER_MS;
}

/**
 * A dismissal only holds until the item changes. Newer activity than the
 * dismissal means the thing the operator waved away is not the thing in
 * front of them now, so it comes back.
 *
 * What counts as "changed" is the row's business. Most rows say any activity
 * at all; a failing agent says only a different problem, because otherwise
 * dismissing something that breaks every twenty minutes buys twenty minutes.
 */
export function isAttentionRowDismissed(
  row: AttentionRow,
  dismissedAtByKey: ReadonlyMap<string, number> | undefined,
): boolean {
  if (!dismissedAtByKey?.size) return false;
  const dismissedAt = dismissedAtByKey.get(row.key);
  if (dismissedAt === undefined) return false;
  return dismissedAt >= (row.sameProblemSinceMs ?? row.updatedAtMs);
}

export function attentionQueueService(db: Db) {
  /**
   * Approvals an operator can still act on. Includes revision_requested,
   * which the old Brief query silently dropped while every badge counted it.
   */
  async function approvalRows(companyId: string): Promise<AttentionRow[]> {
    const rows = await db
      .select({
        id: approvals.id,
        type: approvals.type,
        status: approvals.status,
        payload: approvals.payload,
        createdAt: approvals.createdAt,
        updatedAt: approvals.updatedAt,
      })
      .from(approvals)
      .where(
        and(
          eq(approvals.companyId, companyId),
          inArray(approvals.status, ACTIONABLE_APPROVAL_STATUSES),
        ),
      )
      .orderBy(desc(approvals.createdAt));

    return rows.map((row) => ({
      key: `approval:${row.id}`,
      kind: "approval" as AttentionKind,
      companyId,
      // Same words the UI shows on the approval page and in the Brief.
      title: truncate(approvalLabel(row.type, row.payload)),
      detail: row.status === "revision_requested" ? "You asked for changes; it is back" : null,
      askedBy: null,
      // Approvals gate an action, not an agent's execution: the agent that
      // drafted it has already moved on or gone back to sleep.
      blocking: "waiting" as const,
      blockedSinceMs: ms(row.createdAt),
      count: 1,
      consequence: "Nothing is sent or changed until you decide.",
      // Nothing in Paperclip decides this for you. It waits.
      deadlineAtMs: null,
      deadlineOutcome: null,
      href: `/approvals/${row.id}`,
      createdAtMs: ms(row.createdAt) ?? 0,
      updatedAtMs: ms(row.updatedAt) ?? ms(row.createdAt) ?? 0,
    }));
  }

  /**
   * Unanswered agent questions. Deduped to one row per issue: three
   * questions on one issue is one row saying "3 questions".
   */
  async function questionRows(companyId: string): Promise<AttentionRow[]> {
    const pending = await issueThreadInteractionService(db).listPendingForCompany(companyId, {
      limit: 200,
    });
    const byIssue = new Map<string, typeof pending>();
    for (const interaction of pending) {
      const list = byIssue.get(interaction.issueId) ?? [];
      list.push(interaction);
      byIssue.set(interaction.issueId, list);
    }

    return [...byIssue.values()].map((group) => {
      const first = group[0];
      // wake_assignee means the agent genuinely stops until answered; the
      // other policies mean it carried on.
      const stopped = group.some((entry) => entry.continuationPolicy !== "none");
      const headline = first.title?.trim() || first.summary?.trim() || null;
      // A confirmation request lapses by itself when the thing it points at
      // moves on: the document gets a new revision, or a later comment
      // supersedes it. There is no clock, so no countdown, but saying
      // "nothing happens until you decide" here would simply be untrue.
      const canLapse = group.some((entry) => entry.kind === "request_confirmation");
      return {
        // Keyed by ISSUE, not interaction: several questions on one issue
        // are one row that says "3 questions".
        key: `question:${first.issueId}`,
        kind: "question" as AttentionKind,
        companyId,
        title:
          group.length > 1
            ? `${group.length} questions on ${first.issueIdentifier ?? "an issue"}`
            : headline
              ? truncate(headline)
              : "An agent is asking you a question",
        detail: truncate(first.issueTitle, 90),
        askedBy: null,
        blocking: stopped ? ("stopped" as const) : ("waiting" as const),
        blockedSinceMs: ms(first.createdAt),
        count: group.length,
        consequence: stopped
          ? "The agent is paused on this issue until you answer. Waiting costs nothing."
          : "The agent carried on; your answer steers what it does next.",
        // No clock, but not "nothing happens" either: see canLapse above.
        deadlineAtMs: null,
        deadlineOutcome: canLapse
          ? "Lapses on its own if the work it refers to changes."
          : null,
        href: `/issues/${first.issueIdentifier ?? first.issueId}#interaction-${first.id}`,
        createdAtMs: ms(first.createdAt) ?? 0,
        updatedAtMs: ms(first.updatedAt) ?? ms(first.createdAt) ?? 0,
      };
    });
  }

  /** Finished work sitting in a review or approval gate that names a person. */
  async function signOffRows(
    companyId: string,
    actor: AttentionQueueActor,
  ): Promise<AttentionRow[]> {
    const gates = await issueService(db).listPendingHumanReviewsForCompany(companyId, {
      limit: 200,
    });
    // Only the named participant can advance a gate; the server rejects
    // anyone else, so showing another person's gate would be a dead row.
    const mine = gates.filter((gate) =>
      actor.userId ? gate.participantUserId === actor.userId : true,
    );
    return mine.map((gate) => ({
      key: `sign_off:${gate.issueId}`,
      kind: "sign_off" as AttentionKind,
      companyId,
      title:
        gate.stageType === "approval"
          ? `${gate.identifier ?? "An issue"} needs your approval to move forward`
          : `${gate.identifier ?? "An issue"} finished and wants your review`,
      detail: truncate(gate.reviewInstructions ?? gate.title, 90),
      askedBy: null,
      blocking: "waiting" as const,
      // When the gate opened, not when the issue was last touched: any
      // edit moves updatedAt, which made a two-day wait read as minutes.
      blockedSinceMs: ms(gate.pendingSinceAt),
      count: 1,
      consequence: "The issue stays open until you sign it off.",
      // Nothing in Paperclip decides this for you. It waits.
      deadlineAtMs: null,
      deadlineOutcome: null,
      href: `/issues/${gate.identifier ?? gate.issueId}`,
      createdAtMs: ms(gate.updatedAt) ?? 0,
      updatedAtMs: ms(gate.updatedAt) ?? 0,
    }));
  }

  /**
   * Runs that failed with nothing left to try. Keyed by agent + issue and
   * counted, so repeated failures of the same work are one row that says
   * "failed 5 times" instead of one row that hides four of them (or, as the
   * old badge did, zero rows as soon as any later run happened).
   */
  async function runFailureRows(companyId: string): Promise<AttentionRow[]> {
    const rows = await db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        agentName: agents.name,
        status: heartbeatRuns.status,
        error: heartbeatRuns.error,
        errorCode: heartbeatRuns.errorCode,
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        createdAt: heartbeatRuns.createdAt,
        finishedAt: heartbeatRuns.finishedAt,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(and(eq(heartbeatRuns.companyId, companyId), not(eq(agents.status, "terminated"))))
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(RUN_FAILURE_LOOKBACK);

    return mergeRunFailuresBySharedCause(groupUnaddressedRunFailures(rows)).map((group) => {
      const row = group.head;
      const issueId = (row.contextSnapshot as Record<string, unknown> | null)?.issueId;
      const cause = describeRunFailureCause(row.errorCode);
      const startedMs = group.oldestFailureMs ?? ms(row.finishedAt) ?? ms(row.createdAt);
      return {
        // Names the problem, not the run. `run:<id>` used to name the newest
        // failed run, which meant the key changed every time the same thing
        // failed again - so dismissing it bought only the time until the next
        // attempt. These keys hold still while the problem does.
        key: cause
          ? `run-cause:${row.agentId}:${row.errorCode}`
          : `run-group:${row.agentId}:${issueId ?? "no-issue"}`,
        kind: "run_failure" as AttentionKind,
        companyId,
        title: cause
          ? cause.summarize(row.agentName)
          : group.failures > 1
            ? `${row.agentName} failed ${group.failures} times with no retry left`
            : `${row.agentName} failed with no retry left`,
        detail: cause
          ? describeStalledWork(group)
          : row.error
            ? truncate(row.error, 90)
            : null,
        askedBy: row.agentName,
        blocking: "waiting" as const,
        // How long it has actually been broken, not how long since the most
        // recent attempt. An agent failing every twenty minutes for three days
        // was reading as "waiting 12m".
        blockedSinceMs: startedMs,
        sameProblemSinceMs: startedMs,
        count: group.failures,
        consequence: cause
          ? `${cause.fix} Nothing this agent is meant to do gets done meanwhile.`
          : "Paperclip has given up on this work. It stays undone until you act.",
        // Nothing in Paperclip decides this for you. It waits.
        deadlineAtMs: null,
        deadlineOutcome: null,
        href: `/agents/${row.agentId}/runs/${row.id}`,
        runId: row.id,
        createdAtMs: ms(row.createdAt) ?? 0,
        updatedAtMs: ms(row.finishedAt) ?? ms(row.createdAt) ?? 0,
      };
    });
  }

  /**
   * Budget stops that paused work. Incidents that already carry a pending
   * approval are NOT duplicated here: they surface as that approval row.
   */
  async function budgetStopRows(companyId: string): Promise<AttentionRow[]> {
    const rows = await db
      .select({
        id: budgetIncidents.id,
        scopeType: budgetIncidents.scopeType,
        thresholdType: budgetIncidents.thresholdType,
        amountLimit: budgetIncidents.amountLimit,
        amountObserved: budgetIncidents.amountObserved,
        approvalId: budgetIncidents.approvalId,
        createdAt: budgetIncidents.createdAt,
        updatedAt: budgetIncidents.updatedAt,
      })
      .from(budgetIncidents)
      .where(
        and(
          eq(budgetIncidents.companyId, companyId),
          eq(budgetIncidents.status, "open"),
          eq(budgetIncidents.thresholdType, "hard"),
          isNull(budgetIncidents.approvalId),
        ),
      )
      .orderBy(desc(budgetIncidents.createdAt));

    return rows.map((row) => ({
      key: `budget:${row.id}`,
      kind: "budget_stop" as AttentionKind,
      companyId,
      title: `Budget cap reached, ${row.scopeType} work is paused`,
      detail: `Spent ${(row.amountObserved / 100).toFixed(2)} against a ${(row.amountLimit / 100).toFixed(2)} cap`,
      askedBy: null,
      blocking: "stopped" as const,
      blockedSinceMs: ms(row.createdAt),
      count: 1,
      consequence: "Work stays paused until you raise the cap or accept the stop.",
      // Nothing in Paperclip decides this for you. It waits.
      deadlineAtMs: null,
      deadlineOutcome: null,
      href: `/costs`,
      createdAtMs: ms(row.createdAt) ?? 0,
      updatedAtMs: ms(row.updatedAt) ?? ms(row.createdAt) ?? 0,
    }));
  }

  /** People asking to join, for actors allowed to decide. */
  async function joinRequestRows(
    companyId: string,
    actor: AttentionQueueActor,
  ): Promise<AttentionRow[]> {
    if (!actor.canApproveJoins) return [];
    const rows = await db
      .select({
        id: joinRequests.id,
        requestType: joinRequests.requestType,
        status: joinRequests.status,
        requestingUserId: joinRequests.requestingUserId,
        requestEmailSnapshot: joinRequests.requestEmailSnapshot,
        createdAt: joinRequests.createdAt,
        updatedAt: joinRequests.updatedAt,
      })
      .from(joinRequests)
      .where(
        and(eq(joinRequests.companyId, companyId), eq(joinRequests.status, "pending_approval")),
      );

    return collapseDuplicatePendingHumanJoinRequests(rows).map((row) => ({
      key: `join:${row.id}`,
      kind: "join_request" as AttentionKind,
      companyId,
      title: `${row.requestEmailSnapshot ?? "Someone"} wants to join`,
      detail: row.requestType ? row.requestType.replace(/_/g, " ") : null,
      askedBy: row.requestEmailSnapshot ?? null,
      blocking: "waiting" as const,
      blockedSinceMs: ms(row.createdAt),
      count: 1,
      consequence: "They cannot see anything in this company until you decide.",
      // Nothing in Paperclip decides this for you. It waits.
      deadlineAtMs: null,
      deadlineOutcome: null,
      href: `/inbox`,
      createdAtMs: ms(row.createdAt) ?? 0,
      updatedAtMs: ms(row.updatedAt) ?? ms(row.createdAt) ?? 0,
    }));
  }

  /**
   * Emails handed to an agent that nobody has picked up.
   *
   * The P5a specification's §4.5 recommends extending this queue rather than
   * inventing a second "things are stuck" list, and this is that. Only the
   * `delegated` state counts: once an agent has acknowledged, the work being
   * slow is the issue's problem to report, not the handover's, and reporting
   * both would put the same thing in front of you twice.
   *
   * "waiting" rather than "stopped": nothing is frozen, but a real person
   * emailed and nobody has started. The threshold is deliberately generous —
   * an agent that has not woken within an hour is not merely busy.
   */
  async function staleEmailHandoffRows(companyId: string): Promise<AttentionRow[]> {
    const cutoff = new Date(Date.now() - STALE_EMAIL_HANDOFF_AFTER_MS);
    const rows = await db
      .select({
        id: issueEmailDelegations.id,
        issueId: issueEmailDelegations.issueId,
        mailbox: issueEmailDelegations.mailbox,
        delegatedAt: issueEmailDelegations.delegatedAt,
        updatedAt: issueEmailDelegations.updatedAt,
        issueTitle: issues.title,
        issueIdentifier: issues.identifier,
      })
      .from(issueEmailDelegations)
      .innerJoin(issues, eq(issues.id, issueEmailDelegations.issueId))
      .where(
        and(
          eq(issueEmailDelegations.companyId, companyId),
          eq(issueEmailDelegations.status, "delegated"),
          lt(issueEmailDelegations.delegatedAt, cutoff),
        ),
      )
      .orderBy(issueEmailDelegations.delegatedAt)
      .limit(50);

    return rows.map((row) => ({
      key: `email-handoff:${row.id}`,
      kind: "email_handoff_stale" as AttentionKind,
      companyId,
      title: `An email handed over has not been picked up`,
      detail: row.issueTitle,
      askedBy: null,
      blocking: "waiting" as const,
      blockedSinceMs: ms(row.delegatedAt),
      count: 1,
      consequence: "Whoever sent it is still waiting for an answer.",
      deadlineAtMs: null,
      deadlineOutcome: null,
      href: `/issues/${row.issueIdentifier ?? row.issueId}`,
      createdAtMs: ms(row.delegatedAt) ?? 0,
      updatedAtMs: ms(row.updatedAt) ?? ms(row.delegatedAt) ?? 0,
    }));
  }

  return {
    /**
     * Every open decision for one company, newest wait first, with stopped
     * agents ahead of everything else.
     */
    listForCompany: async (
      companyId: string,
      actor: AttentionQueueActor,
      options: { includeSetAside?: boolean } = {},
    ): Promise<AttentionQueueResult> => {
      const [approvalsList, questions, signOffs, runFailures, budgetStops, joins, staleHandoffs] =
        await Promise.all([
          approvalRows(companyId),
          questionRows(companyId),
          signOffRows(companyId, actor),
          runFailureRows(companyId),
          budgetStopRows(companyId),
          joinRequestRows(companyId, actor),
          staleEmailHandoffRows(companyId),
        ]);

      const all = [
        ...approvalsList,
        ...questions,
        ...signOffs,
        ...runFailures,
        ...budgetStops,
        ...joins,
        ...staleHandoffs,
      ];
      const nowMs = Date.now();
      const visible = all.filter(
        (row) =>
          !isAttentionRowDismissed(row, actor.dismissedAtByKey)
          && !isAttentionRowSnoozed(row, actor.snoozedUntilByKey, nowMs),
      );

      // Split rather than drop. A row that has gone quiet is still findable,
      // and the count travels with the response so a surface can say how many
      // it is not showing instead of quietly showing fewer.
      const live: AttentionRow[] = [];
      const setAside: AttentionRow[] = [];
      for (const row of visible) {
        (isAttentionRowSetAside(row, nowMs) ? setAside : live).push(row);
      }

      return {
        rows: sortAttentionRows(options.includeSetAside ? visible : live),
        setAside: setAside.length,
      };
    },
  };
}

/** Minimal shape of a run row needed to decide whether it still needs a human. */
export interface RunFailureCandidate {
  id: string;
  agentId: string;
  status: string;
  errorCode?: string | null;
  scheduledRetryAt: Date | string | null;
  contextSnapshot: unknown;
  createdAt?: Date | string | null;
  finishedAt?: Date | string | null;
}

/** One problem: its newest run, how often it has happened, and since when. */
export interface RunFailureGroup<T extends RunFailureCandidate> {
  head: T;
  failures: number;
  /** When this run of trouble began, which is what the row reports and what a dismissal is measured against. */
  oldestFailureMs: number | null;
  /** How many separate pieces of work this one problem is holding up. */
  stalledWork: number;
}

/**
 * Which run failures are still waiting on a human, and how many times each
 * piece of work has failed.
 *
 * Input must be newest-first. Work is keyed by (agent, issue), not by agent
 * alone: the old badge kept only each agent's most recent run, so twenty
 * failures read as one, and a single failure followed by any later run on
 * ANY issue read as zero, which let the badge hit zero while the work was
 * still broken.
 *
 * A group stops needing a human when a newer non-failed run exists for the
 * same work, or when a retry is already scheduled (the system is still
 * trying, so it is not a decision yet).
 */
export function groupUnaddressedRunFailures<T extends RunFailureCandidate>(
  newestFirst: readonly T[],
): Array<RunFailureGroup<T>> {
  const groups = new Map<
    string,
    { head: T; failures: number; closed: boolean; oldestFailureMs: number | null; stalledWork: number }
  >();
  for (const row of newestFirst) {
    const issueId = (row.contextSnapshot as Record<string, unknown> | null)?.issueId ?? null;
    const groupKey = `${row.agentId}:${typeof issueId === "string" ? issueId : "no-issue"}`;
    const existing = groups.get(groupKey);
    const failed = FAILED_RUN_STATUSES.includes(row.status);
    if (!existing) {
      groups.set(groupKey, {
        head: row,
        failures: failed ? 1 : 0,
        closed: !failed,
        oldestFailureMs: failed ? runFailedAtMs(row) : null,
        stalledWork: 1,
      });
      continue;
    }
    if (existing.closed) continue;
    if (failed) {
      existing.failures += 1;
      // Input is newest-first, so every later match is older than the last.
      existing.oldestFailureMs = runFailedAtMs(row) ?? existing.oldestFailureMs;
    } else existing.closed = true;
  }

  return [...groups.values()]
    .filter((group) => !group.closed && group.failures > 0 && !group.head.scheduledRetryAt)
    .map(({ head, failures, oldestFailureMs, stalledWork }) => ({
      head,
      failures,
      oldestFailureMs,
      stalledWork,
    }));
}

/**
 * Collapse an agent's groups that all failed for the same, single reason.
 *
 * One expired login is one problem, however many pieces of work it stalls.
 * Left ungrouped it reads as four separate things to deal with, each with its
 * own "failed 3 times" count, each pointing at a different run, none of them
 * mentioning the login. Only causes where retrying cannot work are merged: two
 * crashes with no error code can genuinely be two different bugs, so those stay
 * as they are.
 */
export function mergeRunFailuresBySharedCause<T extends RunFailureCandidate>(
  groups: readonly RunFailureGroup<T>[],
): Array<RunFailureGroup<T>> {
  const merged: Array<RunFailureGroup<T>> = [];
  const byCause = new Map<string, RunFailureGroup<T>>();

  for (const group of groups) {
    const errorCode = group.head.errorCode ?? null;
    if (!isSingleCauseFailure(errorCode)) {
      merged.push(group);
      continue;
    }
    const causeKey = `${group.head.agentId}:${errorCode}`;
    const existing = byCause.get(causeKey);
    if (!existing) {
      byCause.set(causeKey, group);
      continue;
    }
    // Groups arrive with the newest run at the head of each, so keep whichever
    // head is newer and stretch the window back to the oldest failure of all.
    const keepExistingHead =
      (runFailedAtMs(existing.head) ?? 0) >= (runFailedAtMs(group.head) ?? 0);
    byCause.set(causeKey, {
      head: keepExistingHead ? existing.head : group.head,
      failures: existing.failures + group.failures,
      oldestFailureMs: oldestOf(existing.oldestFailureMs, group.oldestFailureMs),
      stalledWork: existing.stalledWork + group.stalledWork,
    });
  }

  return [...merged, ...byCause.values()];
}

function runFailedAtMs(row: RunFailureCandidate): number | null {
  return ms(row.finishedAt) ?? ms(row.createdAt);
}

function oldestOf(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/** Stopped first, then longest-waiting first. */
export function sortAttentionRows(rows: AttentionRow[]): AttentionRow[] {
  return [...rows].sort((a, b) => {
    if (a.blocking !== b.blocking) return a.blocking === "stopped" ? -1 : 1;
    const aWait = a.blockedSinceMs ?? a.createdAtMs;
    const bWait = b.blockedSinceMs ?? b.createdAtMs;
    return aWait - bWait;
  });
}
