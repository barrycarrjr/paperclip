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
  /** How many occurrences this row stands for (>= 1). */
  count: number;
  /** What happens if this is ignored. Computed, never a canned phrase. */
  consequence: string | null;
  /** Company-relative path where the decision can actually be made. */
  href: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface AttentionQueueResponse {
  rows: AttentionRow[];
  /** Total open rows, which is also the one number every badge shows. */
  count: number;
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
 * failures of the same work ("failed 5 times"); this is the newest one, and
 * the id any dismissal of the row is recorded against.
 */
export function attentionRowRunId(row: AttentionRow): string | null {
  if (row.kind !== "run_failure") return null;
  const separator = row.key.indexOf(":");
  if (separator < 0) return null;
  const id = row.key.slice(separator + 1);
  return id.length > 0 ? id : null;
}
