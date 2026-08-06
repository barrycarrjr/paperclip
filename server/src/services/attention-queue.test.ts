import { describe, expect, it } from "vitest";
import type { AttentionRow } from "@paperclipai/shared";
import {
  groupUnaddressedRunFailures,
  sortAttentionRows,
  type RunFailureCandidate,
} from "./attention-queue.js";

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
});
