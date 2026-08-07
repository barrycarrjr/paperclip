import { describe, expect, it } from "vitest";
import type { AttentionRow } from "@paperclipai/shared";
import {
  groupUnaddressedRunFailures,
  isAttentionRowDismissed,
  isAttentionRowSnoozed,
  mergeRunFailuresBySharedCause,
  sortAttentionRows,
  type RunFailureCandidate,
} from "./attention-queue.js";
import { summarizeAttentionForBadges } from "../routes/sidebar-badges.js";

function row(overrides: Partial<AttentionRow> = {}): AttentionRow {
  return {
    key: "approval:1",
    kind: "approval",
    companyId: "c-1",
    title: "Something needs you",
    detail: null,
    askedBy: null,
    blocking: "waiting",
    blockedSinceMs: 1_000,
    count: 1,
    consequence: null,
    deadlineAtMs: null,
    deadlineOutcome: null,
    href: "/approvals/1",
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    ...overrides,
  };
}

describe("sortAttentionRows", () => {
  it("puts stopped agents ahead of everything else", () => {
    const sorted = sortAttentionRows([
      row({ key: "a", blocking: "waiting", blockedSinceMs: 1 }),
      row({ key: "b", blocking: "stopped", blockedSinceMs: 9_000 }),
    ]);
    expect(sorted.map((r) => r.key)).toEqual(["b", "a"]);
  });

  it("orders longest wait first within a tier", () => {
    const sorted = sortAttentionRows([
      row({ key: "new", blockedSinceMs: 5_000 }),
      row({ key: "old", blockedSinceMs: 1_000 }),
      row({ key: "middle", blockedSinceMs: 3_000 }),
    ]);
    expect(sorted.map((r) => r.key)).toEqual(["old", "middle", "new"]);
  });

  it("falls back to created time when nothing is blocked yet", () => {
    const sorted = sortAttentionRows([
      row({ key: "second", blockedSinceMs: null, createdAtMs: 20 }),
      row({ key: "first", blockedSinceMs: null, createdAtMs: 10 }),
    ]);
    expect(sorted.map((r) => r.key)).toEqual(["first", "second"]);
  });

  it("does not mutate the input", () => {
    const input = [row({ key: "a" }), row({ key: "b", blocking: "stopped" })];
    sortAttentionRows(input);
    expect(input.map((r) => r.key)).toEqual(["a", "b"]);
  });
});

describe("groupUnaddressedRunFailures", () => {
  function run(overrides: Partial<RunFailureCandidate> = {}): RunFailureCandidate {
    return {
      id: "run-1",
      agentId: "agent-1",
      status: "failed",
      scheduledRetryAt: null,
      contextSnapshot: { issueId: "issue-1" },
      ...overrides,
    };
  }

  it("counts consecutive failures of the same work as one row", () => {
    const groups = groupUnaddressedRunFailures([
      run({ id: "r3" }),
      run({ id: "r2" }),
      run({ id: "r1" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].failures).toBe(3);
    // The newest failure represents the group.
    expect(groups[0].head.id).toBe("r3");
  });

  it("clears the work once a later run on the SAME issue succeeded", () => {
    const groups = groupUnaddressedRunFailures([
      run({ id: "ok", status: "succeeded" }),
      run({ id: "bad" }),
    ]);
    expect(groups).toEqual([]);
  });

  it("keeps a failure that a later run on a DIFFERENT issue did not address", () => {
    // The old badge collapsed to the agent's latest run, so this failure
    // silently disappeared and the count could read zero.
    const groups = groupUnaddressedRunFailures([
      run({ id: "other", status: "succeeded", contextSnapshot: { issueId: "issue-2" } }),
      run({ id: "stillBroken", contextSnapshot: { issueId: "issue-1" } }),
    ]);
    expect(groups.map((g) => g.head.id)).toEqual(["stillBroken"]);
  });

  it("stays quiet while the system still has a retry scheduled", () => {
    const groups = groupUnaddressedRunFailures([
      run({ id: "retrying", scheduledRetryAt: new Date().toISOString() }),
    ]);
    expect(groups).toEqual([]);
  });

  it("separates two agents failing on the same issue", () => {
    const groups = groupUnaddressedRunFailures([
      run({ id: "a", agentId: "agent-1" }),
      run({ id: "b", agentId: "agent-2" }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("treats runs with no issue as one bucket per agent", () => {
    const groups = groupUnaddressedRunFailures([
      run({ id: "n2", contextSnapshot: null }),
      run({ id: "n1", contextSnapshot: {} }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].failures).toBe(2);
  });

  it("reports when the trouble started, not when it last happened", () => {
    // The row says "waiting 3d" off this. Taking the newest failure instead
    // made an agent that had been broken since Tuesday read as "waiting 12m".
    const groups = groupUnaddressedRunFailures([
      run({ id: "r2", finishedAt: new Date(9_000).toISOString() }),
      run({ id: "r1", finishedAt: new Date(1_000).toISOString() }),
    ]);
    expect(groups[0].oldestFailureMs).toBe(1_000);
  });
});

describe("mergeRunFailuresBySharedCause", () => {
  function run(overrides: Partial<RunFailureCandidate> = {}): RunFailureCandidate {
    return {
      id: "run-1",
      agentId: "agent-1",
      status: "failed",
      scheduledRetryAt: null,
      contextSnapshot: { issueId: "issue-1" },
      ...overrides,
    };
  }

  function group(
    head: RunFailureCandidate,
    failures = 1,
    oldestFailureMs: number | null = 1_000,
  ) {
    return { head, failures, oldestFailureMs, stalledWork: 1 };
  }

  it("makes one expired login into one row", () => {
    // The operator's actual complaint: four rows, four counts, four "Open run"
    // buttons, for a single thing that one pasted token fixes.
    const merged = mergeRunFailuresBySharedCause([
      group(run({ id: "a", errorCode: "claude_auth_required" }), 3),
      group(run({ id: "b", errorCode: "claude_auth_required" }), 2),
      group(run({ id: "c", errorCode: "claude_auth_required" }), 2),
      group(run({ id: "d", errorCode: "claude_auth_required" }), 3),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.failures).toBe(10);
    expect(merged[0]!.stalledWork).toBe(4);
  });

  it("keeps the newest run as the one to open", () => {
    const merged = mergeRunFailuresBySharedCause([
      group(run({ id: "old", errorCode: "claude_auth_required", finishedAt: new Date(1_000).toISOString() })),
      group(run({ id: "new", errorCode: "claude_auth_required", finishedAt: new Date(9_000).toISOString() })),
    ]);
    expect(merged[0]!.head.id).toBe("new");
  });

  it("stretches the window back to the earliest failure of the lot", () => {
    const merged = mergeRunFailuresBySharedCause([
      group(run({ id: "a", errorCode: "claude_auth_required" }), 1, 5_000),
      group(run({ id: "b", errorCode: "claude_auth_required" }), 1, 500),
    ]);
    expect(merged[0]!.oldestFailureMs).toBe(500);
  });

  it("leaves two agents with the same problem as two rows", () => {
    // One token fixes one agent, so these really are two things to do.
    const merged = mergeRunFailuresBySharedCause([
      group(run({ id: "a", agentId: "agent-1", errorCode: "claude_auth_required" })),
      group(run({ id: "b", agentId: "agent-2", errorCode: "claude_auth_required" })),
    ]);
    expect(merged).toHaveLength(2);
  });

  it("does not merge plain crashes", () => {
    // Two failures with no error code can be two different bugs. Collapsing
    // them would hide one behind the other.
    const merged = mergeRunFailuresBySharedCause([
      group(run({ id: "a", contextSnapshot: { issueId: "issue-1" } })),
      group(run({ id: "b", contextSnapshot: { issueId: "issue-2" } })),
    ]);
    expect(merged).toHaveLength(2);
  });

  it("does not merge failures whose fix is per-run", () => {
    // A timeout has a known meaning but retrying is a reasonable answer to it,
    // so each piece of work stays its own decision.
    const merged = mergeRunFailuresBySharedCause([
      group(run({ id: "a", errorCode: "timeout" })),
      group(run({ id: "b", errorCode: "timeout" })),
    ]);
    expect(merged).toHaveLength(2);
  });

  it("keeps unmergeable rows alongside merged ones", () => {
    const merged = mergeRunFailuresBySharedCause([
      group(run({ id: "auth-1", errorCode: "claude_auth_required" })),
      group(run({ id: "crash", errorCode: null })),
      group(run({ id: "auth-2", errorCode: "claude_auth_required" })),
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.map((g) => g.head.id).sort()).toEqual(["auth-1", "crash"]);
  });
});

describe("isAttentionRowDismissed", () => {
  it("hides a row this person waved away", () => {
    const dismissals = new Map([["approval:1", 5_000]]);
    expect(isAttentionRowDismissed(row({ key: "approval:1", updatedAtMs: 1_000 }), dismissals)).toBe(true);
  });

  it("brings it back once the thing itself changes", () => {
    // The operator dismissed the version they saw. Newer activity means this
    // is not that version any more, so it is theirs to look at again.
    const dismissals = new Map([["approval:1", 5_000]]);
    expect(isAttentionRowDismissed(row({ key: "approval:1", updatedAtMs: 9_000 }), dismissals)).toBe(false);
  });

  it("leaves everything alone when nobody has dismissed anything", () => {
    expect(isAttentionRowDismissed(row(), undefined)).toBe(false);
    expect(isAttentionRowDismissed(row(), new Map())).toBe(false);
  });

  it("keeps a failing agent quiet when it fails the same way again", () => {
    // The operator's Steward failed every twenty minutes for three days with
    // an expired login. Comparing against the newest failure meant dismissing
    // it bought twenty minutes, so it was never really dismissable at all.
    const dismissed = row({
      key: "run-cause:agent-1:claude_auth_required",
      kind: "run_failure",
      sameProblemSinceMs: 1_000,
      updatedAtMs: 90_000,
    });
    expect(
      isAttentionRowDismissed(dismissed, new Map([["run-cause:agent-1:claude_auth_required", 5_000]])),
    ).toBe(true);
  });

  it("brings a failing agent back once the problem is a different one", () => {
    // A different cause is a different key, which no dismissal covers.
    const nowFailingDifferently = row({
      key: "run-cause:agent-1:timeout",
      kind: "run_failure",
      sameProblemSinceMs: 1_000,
      updatedAtMs: 90_000,
    });
    expect(
      isAttentionRowDismissed(
        nowFailingDifferently,
        new Map([["run-cause:agent-1:claude_auth_required", 5_000]]),
      ),
    ).toBe(false);
  });

  it("brings it back if the trouble restarts after the dismissal", () => {
    // Dismissed on Monday, the agent recovered, then broke again on Friday.
    // That is a new run of trouble, so it is news again.
    const brokeAgain = row({
      key: "run-cause:agent-1:claude_auth_required",
      kind: "run_failure",
      sameProblemSinceMs: 9_000,
      updatedAtMs: 9_500,
    });
    expect(
      isAttentionRowDismissed(brokeAgain, new Map([["run-cause:agent-1:claude_auth_required", 5_000]])),
    ).toBe(false);
  });

  it("does not confuse one row's key for another's", () => {
    const dismissals = new Map([["approval:1", 5_000]]);
    expect(isAttentionRowDismissed(row({ key: "approval:2" }), dismissals)).toBe(false);
  });
});

describe("summarizeAttentionForBadges", () => {
  it("counts one row as one thing to deal with", () => {
    const badges = summarizeAttentionForBadges([
      row({ key: "approval:1", kind: "approval" }),
      row({ key: "approval:2", kind: "approval" }),
      row({ key: "question:i1", kind: "question" }),
      row({ key: "sign_off:i2", kind: "sign_off" }),
      row({ key: "run:r1", kind: "run_failure" }),
      row({ key: "join:j1", kind: "join_request" }),
      row({ key: "budget:b1", kind: "budget_stop" }),
    ]);

    expect(badges).toEqual({ inbox: 7, approvals: 2, failedRuns: 1, joinRequests: 1 });
  });

  it("does not multiply a repeated problem into several units of work", () => {
    // "failed 5 times" is one thing to go and look at, not five.
    const badges = summarizeAttentionForBadges([row({ key: "run:r1", kind: "run_failure", count: 5 })]);
    expect(badges).toEqual({ inbox: 1, approvals: 0, failedRuns: 1, joinRequests: 0 });
  });

  it("is zero across the board on an empty queue", () => {
    expect(summarizeAttentionForBadges([])).toEqual({
      inbox: 0,
      approvals: 0,
      failedRuns: 0,
      joinRequests: 0,
    });
  });
});

describe("isAttentionRowSnoozed", () => {
  const NOW = 1_000_000;

  it("hides a row until its time is up", () => {
    const snoozes = new Map([["approval:1", NOW + 60_000]]);
    expect(isAttentionRowSnoozed(row({ key: "approval:1" }), snoozes, NOW)).toBe(true);
  });

  it("brings it back the moment the time passes", () => {
    const snoozes = new Map([["approval:1", NOW - 1]]);
    expect(isAttentionRowSnoozed(row({ key: "approval:1" }), snoozes, NOW)).toBe(false);
  });

  it("holds even when the item changes underneath it", () => {
    // This is the whole difference from a dismissal. "Not until tomorrow" is a
    // decision about the operator's day, so an edit must not drag it back.
    const snoozes = new Map([["approval:1", NOW + 60_000]]);
    const edited = row({ key: "approval:1", updatedAtMs: NOW + 30_000 });
    expect(isAttentionRowSnoozed(edited, snoozes, NOW)).toBe(true);
    // Contrast: the same edit lifts a dismissal.
    expect(isAttentionRowDismissed(edited, new Map([["approval:1", NOW]]))).toBe(false);
  });

  it("leaves everything alone when nothing is snoozed", () => {
    expect(isAttentionRowSnoozed(row(), undefined, NOW)).toBe(false);
    expect(isAttentionRowSnoozed(row(), new Map(), NOW)).toBe(false);
  });

  it("does not confuse one row's key for another's", () => {
    const snoozes = new Map([["approval:1", NOW + 60_000]]);
    expect(isAttentionRowSnoozed(row({ key: "approval:2" }), snoozes, NOW)).toBe(false);
  });

  it("survives a run failing again, which renames the row", () => {
    // A run-failure row is keyed by the newest failed run, so the key changes
    // every time the same work fails. Snoozing a noisy agent is the main
    // reason to snooze anything, so it has to be recorded against the work.
    const snoozes = new Map([["run-group:agent-1:iss-1", NOW + 60_000]]);
    const before = row({
      key: "run:run-a",
      kind: "run_failure",
      snoozeKey: "run-group:agent-1:iss-1",
    });
    const afterAnotherFailure = row({
      key: "run:run-b",
      kind: "run_failure",
      snoozeKey: "run-group:agent-1:iss-1",
    });

    expect(isAttentionRowSnoozed(before, snoozes, NOW)).toBe(true);
    expect(isAttentionRowSnoozed(afterAnotherFailure, snoozes, NOW)).toBe(true);
  });

  it("keeps a snooze for one agent's work off another's", () => {
    const snoozes = new Map([["run-group:agent-1:iss-1", NOW + 60_000]]);
    expect(
      isAttentionRowSnoozed(
        row({ key: "run:run-c", kind: "run_failure", snoozeKey: "run-group:agent-2:iss-1" }),
        snoozes,
        NOW,
      ),
    ).toBe(false);
  });
});
