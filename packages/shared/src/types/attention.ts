/**
 * The attention queue: the one list of decisions that are open and only a
 * human can make. Every surface that asks the operator to act (the Brief's
 * "Awaiting your tap", the Inbox, every badge) renders these rows. No
 * surface computes its own version of "needs you".
 */

export const ATTENTION_KINDS = [
  "approval",
  "question",
  "sign_off",
  "run_failure",
  "budget_stop",
  "join_request",
  "email_sender",
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

/**
 * "stopped" means an agent is halted until the operator answers; "waiting"
 * means nothing is frozen but a decision is still open. Anything the system
 * can still resolve itself is not a row at all.
 */
export type AttentionBlocking = "stopped" | "waiting";

export interface AttentionRow {
  /**
   * Stable identity of the PROBLEM, not the event: repeated occurrences
   * raise `count` instead of adding rows. Also the dismissal key, and it
   * keeps the existing `approval:<id>` / `run:<id>` / `join:<id>` shapes so
   * dismissals recorded before the queue existed still apply.
   */
  key: string;
  /**
   * What a snooze is recorded against. Defaults to `key`, and differs only
   * where `key` is not stable across repeats: a run-failure row is keyed by
   * the newest failed run, so its id changes every time the same work fails
   * again. Snoozing has to survive that, or the one row an operator most
   * wants quiet is the one that will not stay quiet.
   */
  snoozeKey?: string;
  kind: AttentionKind;
  companyId: string;
  /** Present on portfolio responses so rows can be grouped and linked. */
  companyName?: string | null;
  companyIssuePrefix?: string | null;
  /** One plain sentence: what is being asked. */
  title: string;
  /** Secondary context (issue, recipient, amount). */
  detail: string | null;
  /** Who is asking, by name, when known. */
  askedBy: string | null;
  blocking: AttentionBlocking;
  /** Epoch ms the wait began, for the "stopped 3h" readout. */
  blockedSinceMs: number | null;
  /**
   * When this exact problem started, for rows where the same thing happening
   * again is not news.
   *
   * A dismissal normally lapses the moment anything about the row changes,
   * which is right for a question someone has since edited. It is wrong for an
   * agent that is failing every twenty minutes for the same reason: waving it
   * away would last exactly until the next attempt. So a dismissal is measured
   * against this instead, and only a genuinely different problem - a different
   * cause, or the work starting to succeed - brings the row back. Null, the
   * usual case, keeps the old behaviour.
   */
  sameProblemSinceMs?: number | null;
  /** How many occurrences this row stands for (>= 1). */
  count: number;
  /** What happens if this is ignored. Computed, never a canned phrase. */
  consequence: string | null;
  /**
   * When something happens on its own, and what. Almost nothing in Paperclip
   * has one: an unapproved draft simply waits, forever, costing nothing. The
   * exception is a Clippy permission prompt, which the server really does
   * deny after five minutes. Null means nothing happens until you decide, and
   * that is worth saying out loud rather than leaving the operator to guess.
   */
  deadlineAtMs: number | null;
  /** What happens at the deadline, in plain words. */
  deadlineOutcome: string | null;
  /** Company-relative path where the decision can actually be made. */
  href: string;
  /**
   * The newest failed run behind a run-failure row. Carried as a field rather
   * than read out of `key`, because the key names the problem and a problem can
   * outlive any one run of it.
   */
  runId?: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface AttentionQueueResponse {
  rows: AttentionRow[];
  /** Total open rows, which is also the one number every badge shows. */
  count: number;
  /**
   * Rows held back because they have gone quiet - a failure that has not
   * happened again in a fortnight is history, not a decision.
   *
   * Reported rather than silently dropped, so a surface can say how many it is
   * not showing. Ask for them with `?setAside=1`.
   */
  setAside?: number;
}

/**
 * The row key is `${kind}:${id}`. For a question or a sign-off gate that id
 * is the issue's id, which lets a surface that already lists issues avoid
 * showing the same issue twice. Kept as one helper so the shape of the key
 * is stated once rather than re-parsed by eye at each call site.
 */
export function attentionRowIssueId(row: AttentionRow): string | null {
  if (row.kind !== "question" && row.kind !== "sign_off") return null;
  const separator = row.key.indexOf(":");
  if (separator < 0) return null;
  const id = row.key.slice(separator + 1);
  return id.length > 0 ? id : null;
}

/**
 * The run whose failure this row stands for. A row can represent several
 * failures ("failed 5 times"), and this is the newest of them - the one worth
 * opening to see what went wrong.
 *
 * Older rows carried it inside `key` as `run:<id>`, which is still read here so
 * a queue response from a server that predates the `runId` field keeps working.
 */
export function attentionRowRunId(row: AttentionRow): string | null {
  if (row.kind !== "run_failure") return null;
  if (row.runId) return row.runId;
  if (!row.key.startsWith("run:")) return null;
  const id = row.key.slice("run:".length);
  return id.length > 0 ? id : null;
}

/** What a snooze for this row is stored against. */
export function attentionSnoozeKey(row: Pick<AttentionRow, "key" | "snoozeKey">): string {
  return row.snoozeKey ?? row.key;
}
