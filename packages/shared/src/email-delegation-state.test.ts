import { describe, expect, it } from "vitest";
import {
  EMAIL_DELEGATION_STATES,
  TERMINAL_EMAIL_DELEGATION_STATES,
  checkEmailDelegationTransition,
  delegationStateForIssueStatus,
  isEmailDelegationState,
  isTerminalEmailDelegationState,
  type EmailDelegationState,
} from "./email-delegation-state.js";

function allow(from: EmailDelegationState, to: EmailDelegationState, reason?: string) {
  const result = checkEmailDelegationTransition({ from, to, handedBackReason: reason });
  expect(result, `${from} -> ${to} should be allowed`).toEqual({ ok: true, to });
}

function reject(from: EmailDelegationState, to: EmailDelegationState, reason?: string) {
  const result = checkEmailDelegationTransition({ from, to, handedBackReason: reason });
  expect(result.ok, `${from} -> ${to} should be rejected`).toBe(false);
}

describe("checkEmailDelegationTransition", () => {
  it("walks the normal path", () => {
    allow("delegated", "acknowledged");
    allow("acknowledged", "in_progress");
    allow("in_progress", "needs_review");
    allow("needs_review", "resolved");
  });

  it("lets an agent that finishes in one turn skip the middle states", () => {
    allow("delegated", "resolved");
    allow("delegated", "needs_review");
    allow("acknowledged", "resolved");
  });

  it("allows review to send work back to in progress", () => {
    allow("needs_review", "in_progress");
  });

  it("refuses to move backwards otherwise", () => {
    reject("in_progress", "acknowledged");
    reject("in_progress", "delegated");
    reject("needs_review", "acknowledged");
    reject("acknowledged", "delegated");
  });

  it.each(TERMINAL_EMAIL_DELEGATION_STATES)("treats %s as final", (terminal) => {
    for (const to of EMAIL_DELEGATION_STATES) {
      if (to === terminal) continue;
      reject(terminal, to, "reason");
    }
  });

  it("rejects a repeat of the state already held, without treating it as progress", () => {
    for (const state of EMAIL_DELEGATION_STATES) {
      const result = checkEmailDelegationTransition({ from: state, to: state });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("already");
    }
  });

  it("requires a reason to hand a delegation back", () => {
    reject("in_progress", "handed_back");
    reject("in_progress", "handed_back", "   ");
    allow("in_progress", "handed_back", "Needs someone with billing access");
  });

  it("does not require a reason for the other terminal states", () => {
    allow("in_progress", "resolved");
    allow("in_progress", "re_delegated");
  });

  it("explains itself rather than saying 'invalid'", () => {
    const result = checkEmailDelegationTransition({ from: "resolved", to: "in_progress" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("resolved");
      expect(result.reason).toContain("in_progress");
    }
  });

  it("rejects states it does not recognise instead of guessing", () => {
    expect(checkEmailDelegationTransition({ from: "nonsense", to: "resolved" }).ok).toBe(false);
    expect(checkEmailDelegationTransition({ from: "delegated", to: "finished" }).ok).toBe(false);
    expect(checkEmailDelegationTransition({ from: "", to: "" }).ok).toBe(false);
  });
});

describe("state predicates", () => {
  it("recognises exactly the declared states", () => {
    for (const state of EMAIL_DELEGATION_STATES) expect(isEmailDelegationState(state)).toBe(true);
    expect(isEmailDelegationState("Resolved")).toBe(false);
    expect(isEmailDelegationState(null)).toBe(false);
    expect(isEmailDelegationState(undefined)).toBe(false);
    expect(isEmailDelegationState(3)).toBe(false);
  });

  it("marks only the three finished states terminal", () => {
    expect(isTerminalEmailDelegationState("resolved")).toBe(true);
    expect(isTerminalEmailDelegationState("handed_back")).toBe(true);
    expect(isTerminalEmailDelegationState("re_delegated")).toBe(true);
    expect(isTerminalEmailDelegationState("delegated")).toBe(false);
    expect(isTerminalEmailDelegationState("needs_review")).toBe(false);
  });

  it("keeps the terminal list in step with the database's partial unique index", () => {
    // packages/db/src/migrations/0095_issue_email_delegations.sql excludes
    // exactly these three from the "one open delegation per email" rule. If
    // this list grows, that index has to grow with it or a finished
    // delegation will keep blocking its own email from being handed off again.
    expect([...TERMINAL_EMAIL_DELEGATION_STATES].sort()).toEqual([
      "handed_back",
      "re_delegated",
      "resolved",
    ]);
  });
});

describe("delegationStateForIssueStatus", () => {
  it("mirrors the two statuses that mean the same thing", () => {
    expect(delegationStateForIssueStatus("in_progress")).toBe("in_progress");
    expect(delegationStateForIssueStatus("in_review")).toBe("needs_review");
  });

  it("does not treat closing the issue as resolving the delegation", () => {
    // Resolution can send a reply to a real person, so it must be an explicit
    // act, never a side effect of someone tidying the board.
    expect(delegationStateForIssueStatus("done")).toBeNull();
    expect(delegationStateForIssueStatus("cancelled")).toBeNull();
  });

  it("says nothing for statuses that say nothing about the handover", () => {
    expect(delegationStateForIssueStatus("todo")).toBeNull();
    expect(delegationStateForIssueStatus("backlog")).toBeNull();
    expect(delegationStateForIssueStatus(null)).toBeNull();
    expect(delegationStateForIssueStatus(undefined)).toBeNull();
  });
});
