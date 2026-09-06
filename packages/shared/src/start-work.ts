/**
 * Durable identity for the request issue behind a plain-language "Start work"
 * plan (P5b).
 *
 * When an operator types what they want done and asks for a plan, the server
 * writes one container issue per request (status backlog, no assignee) so the
 * reviewable suggest_tasks card has an issue to hang off. Nothing else is
 * created until a board user accepts. The container is found again by its
 * `originKind`/`originId` pair, where `originId` is the requestKey the browser
 * minted for that one typed request, so a double Enter or a retry after a
 * timeout lands on the same row instead of drafting twice.
 */

/**
 * Not added to `ISSUE_ORIGIN_KINDS`, deliberately. That constant is already
 * not authoritative (`email_handoff`, `harness_liveness_escalation`,
 * `stranded_issue_recovery` and the portfolio-directive kind are all real, in
 * use, and absent from it). This follows that established pattern rather than
 * pretending the shared list is complete.
 *
 * Also not client-declarable: `clientDeclarableIssueOriginSchema` stays
 * limited to the email handoff kind, so only the plan route can mint a
 * container with this kind.
 */
export const START_WORK_ORIGIN_KIND = "start_work";

/**
 * Upper bound on tasks in one drafted plan. The planner prompt says to fold
 * anything beyond this into the summary as "later"; the validator rejects
 * more, so a reviewer is never shown a card longer than they can actually
 * read and decide on.
 */
export const MAX_START_WORK_TASKS = 12;

export function isStartWorkOriginKind(originKind: string | null | undefined): boolean {
  return originKind === START_WORK_ORIGIN_KIND;
}

/**
 * Idempotency key for the plan's suggest_tasks interaction. The interaction
 * table's own uniqueness constraint is scoped per issue, so this key alone
 * cannot stop a second container; it stops a second card on the same one.
 */
export function startWorkInteractionIdempotencyKey(requestKey: string): string {
  return `start-work:${requestKey}`;
}
