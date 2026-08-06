import { and, desc, eq, inArray, isNull, not } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  budgetIncidents,
  heartbeatRuns,
  issues,
  joinRequests,
} from "@paperclipai/db";
import { approvalLabel, type AttentionKind, type AttentionRow } from "@paperclipai/shared";
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

function ms(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function truncate(value: string, max = 120): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
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
}

/**
 * A dismissal only holds until the item changes. Newer activity than the
 * dismissal means the thing the operator waved away is not the thing in
 * front of them now, so it comes back.
 */
export function isAttentionRowDismissed(
  row: AttentionRow,
  dismissedAtByKey: ReadonlyMap<string, number> | undefined,
): boolean {
  if (!dismissedAtByKey?.size) return false;
  const dismissedAt = dismissedAtByKey.get(row.key);
  if (dismissedAt === undefined) return false;
  return dismissedAt >= row.updatedAtMs;
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
      blockedSinceMs: ms(gate.updatedAt),
      count: 1,
      consequence: "The issue stays open until you sign it off.",
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

    return groupUnaddressedRunFailures(rows)
      .map((group) => {
        const row = group.head;
        const issueId = (row.contextSnapshot as Record<string, unknown> | null)?.issueId;
        return {
          key: `run:${row.id}`,
          kind: "run_failure" as AttentionKind,
          companyId,
          title:
            group.failures > 1
              ? `${row.agentName} failed ${group.failures} times with no retry left`
              : `${row.agentName} failed with no retry left`,
          detail: row.error ? truncate(row.error, 90) : null,
          askedBy: row.agentName,
          blocking: "waiting" as const,
          blockedSinceMs: ms(row.finishedAt) ?? ms(row.createdAt),
          count: group.failures,
          consequence: "Paperclip has given up on this work. It stays undone until you act.",
          href: typeof issueId === "string"
            ? `/agents/${row.agentId}/runs/${row.id}`
            : `/agents/${row.agentId}/runs/${row.id}`,
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
      href: `/inbox`,
      createdAtMs: ms(row.createdAt) ?? 0,
      updatedAtMs: ms(row.updatedAt) ?? ms(row.createdAt) ?? 0,
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
    ): Promise<AttentionRow[]> => {
      const [approvalsList, questions, signOffs, runFailures, budgetStops, joins] =
        await Promise.all([
          approvalRows(companyId),
          questionRows(companyId),
          signOffRows(companyId, actor),
          runFailureRows(companyId),
          budgetStopRows(companyId),
          joinRequestRows(companyId, actor),
        ]);

      const all = [
        ...approvalsList,
        ...questions,
        ...signOffs,
        ...runFailures,
        ...budgetStops,
        ...joins,
      ];
      return sortAttentionRows(
        all.filter((row) => !isAttentionRowDismissed(row, actor.dismissedAtByKey)),
      );
    },
  };
}

/** Minimal shape of a run row needed to decide whether it still needs a human. */
export interface RunFailureCandidate {
  id: string;
  agentId: string;
  status: string;
  scheduledRetryAt: Date | string | null;
  contextSnapshot: unknown;
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
): Array<{ head: T; failures: number }> {
  const groups = new Map<string, { head: T; failures: number; closed: boolean }>();
  for (const row of newestFirst) {
    const issueId = (row.contextSnapshot as Record<string, unknown> | null)?.issueId ?? null;
    const groupKey = `${row.agentId}:${typeof issueId === "string" ? issueId : "no-issue"}`;
    const existing = groups.get(groupKey);
    const failed = FAILED_RUN_STATUSES.includes(row.status);
    if (!existing) {
      groups.set(groupKey, { head: row, failures: failed ? 1 : 0, closed: !failed });
      continue;
    }
    if (existing.closed) continue;
    if (failed) existing.failures += 1;
    else existing.closed = true;
  }

  return [...groups.values()]
    .filter((group) => !group.closed && group.failures > 0 && !group.head.scheduledRetryAt)
    .map(({ head, failures }) => ({ head, failures }));
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
