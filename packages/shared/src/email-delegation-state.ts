/**
 * The lifecycle of an email handed to an agent (P5a §3 — see
 * docs/plans/2026-09-03-p5a-email-delegation-spec.md).
 *
 * This is deliberately a SEPARATE thing from `issue.status`. The issue's
 * status tracks the work; this tracks the handover. They come apart in
 * ordinary use: an issue can be reopened months later, reassigned to someone
 * with no connection to the original email, or closed by a person who never
 * saw it. When that happens the delegation should not silently follow along
 * and claim the outcome as its own, because the question it exists to answer
 * is "what happened to the email I handed over", not "what is the state of
 * this work item now".
 *
 *   delegated -> acknowledged -> in_progress -> needs_review -> resolved
 *                                            \-> handed_back -> re_delegated
 *
 * Kept in shared, and pure, because the server writes these transitions, the
 * UI shows them, and the tests check them. A second copy of the rules is how
 * a state machine ends up disagreeing with itself.
 */

export const EMAIL_DELEGATION_STATES = [
  "delegated",
  "acknowledged",
  "in_progress",
  "needs_review",
  "resolved",
  "handed_back",
  "re_delegated",
] as const;

export type EmailDelegationState = (typeof EMAIL_DELEGATION_STATES)[number];

/** States after which the delegation is over and its source is free again. */
export const TERMINAL_EMAIL_DELEGATION_STATES = [
  "resolved",
  "handed_back",
  "re_delegated",
] as const satisfies readonly EmailDelegationState[];

export type TerminalEmailDelegationState =
  (typeof TERMINAL_EMAIL_DELEGATION_STATES)[number];

/**
 * Which states each state may move to.
 *
 * Two shapes here are intentional rather than oversights:
 *
 * - Progress can skip forward (delegated -> needs_review) because an agent
 *   that does the whole job in one turn never passes through the middle
 *   states, and refusing that transition would strand a finished delegation.
 * - It cannot move backwards, except out of `needs_review` back to
 *   `in_progress`, which is a real thing that happens when a review sends
 *   work back.
 *
 * Terminal states have no exits at all. Re-delegating creates a NEW row that
 * points at the old one, so the history stays readable after several rounds
 * instead of one row being overwritten repeatedly.
 */
const ALLOWED_TRANSITIONS: Record<EmailDelegationState, readonly EmailDelegationState[]> = {
  delegated: ["acknowledged", "in_progress", "needs_review", "resolved", "handed_back", "re_delegated"],
  acknowledged: ["in_progress", "needs_review", "resolved", "handed_back", "re_delegated"],
  in_progress: ["needs_review", "resolved", "handed_back", "re_delegated"],
  needs_review: ["in_progress", "resolved", "handed_back", "re_delegated"],
  resolved: [],
  handed_back: [],
  re_delegated: [],
};

export function isEmailDelegationState(value: unknown): value is EmailDelegationState {
  return typeof value === "string" && (EMAIL_DELEGATION_STATES as readonly string[]).includes(value);
}

export function isTerminalEmailDelegationState(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (TERMINAL_EMAIL_DELEGATION_STATES as readonly string[]).includes(value)
  );
}

export interface EmailDelegationTransitionRequest {
  from: EmailDelegationState | string;
  to: EmailDelegationState | string;
  /** Required by the contract when moving to `handed_back`. */
  handedBackReason?: string | null;
}

export type EmailDelegationTransitionResult =
  | { ok: true; to: EmailDelegationState }
  | { ok: false; reason: string };

/**
 * Decide whether one delegation state may become another.
 *
 * Returns a reason rather than throwing so a caller can put the text in front
 * of a person. Every rejection says what was attempted, because "invalid
 * transition" on its own tells whoever hits it nothing about which of the two
 * states was the surprise.
 */
export function checkEmailDelegationTransition(
  request: EmailDelegationTransitionRequest,
): EmailDelegationTransitionResult {
  const { from, to } = request;

  if (!isEmailDelegationState(from)) {
    return { ok: false, reason: `Delegation is in an unrecognised state (${String(from)}).` };
  }
  if (!isEmailDelegationState(to)) {
    return { ok: false, reason: `"${String(to)}" is not a delegation state.` };
  }

  if (from === to) {
    // Re-sending the state you are already in is how a retried request or a
    // double-fired tool call looks. It is not an error and must not be
    // treated as progress either, so it is rejected without alarm.
    return { ok: false, reason: `Delegation is already ${to}.` };
  }

  if (isTerminalEmailDelegationState(from)) {
    return {
      ok: false,
      reason: `Delegation is already finished (${from}) and cannot become ${to}. Re-delegate the email instead.`,
    };
  }

  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    return { ok: false, reason: `A delegation cannot go from ${from} back to ${to}.` };
  }

  if (to === "handed_back" && !request.handedBackReason?.trim()) {
    // Handing work back without saying why leaves the next person guessing,
    // and the whole point of separating handback from resolution is that
    // someone has to pick the work up again.
    return { ok: false, reason: "Handing a delegation back needs a reason." };
  }

  return { ok: true, to };
}

/**
 * Map an issue's own status onto the delegation state it implies, for the
 * states that genuinely mirror each other.
 *
 * Returns null where the issue's status says nothing about the handover.
 * "done" is deliberately absent: closing the issue is not the same as
 * resolving the delegation, because resolution can send a reply to a real
 * person, and that must be an explicit act rather than a side effect of
 * someone tidying a board.
 */
export function delegationStateForIssueStatus(
  issueStatus: string | null | undefined,
): EmailDelegationState | null {
  switch (issueStatus) {
    case "in_progress":
      return "in_progress";
    case "in_review":
      return "needs_review";
    default:
      return null;
  }
}
