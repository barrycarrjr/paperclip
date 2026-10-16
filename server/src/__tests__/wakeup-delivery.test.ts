import { describe, expect, it } from "vitest";
import { classifyWakeupDelivery, isUndeliveredTerminalReceipt } from "../services/wakeup-delivery.js";

describe("wake receipt delivery classification", () => {
  it.each(["cancelled", "failed"])("allows retry of an undelivered %s receipt without a run", (status) => {
    expect(isUndeliveredTerminalReceipt({ status, reason: null, runId: null, runStatus: null, startedAt: null })).toBe(true);
  });
  it.each(["cancelled", "failed", "timed_out"])("allows retry after a %s run that never started", (runStatus) => {
    expect(isUndeliveredTerminalReceipt({ status: "coalesced", reason: null, runId: "run", runStatus, startedAt: null })).toBe(true);
    expect(isUndeliveredTerminalReceipt({ status: "coalesced", reason: null, runId: "run", runStatus, startedAt: new Date() })).toBe(false);
  });
  it.each(["queued", "running", "scheduled_retry", "succeeded", null])("preserves duplicate protection for a %s linked run", (runStatus) => {
    expect(isUndeliveredTerminalReceipt({ status: "queued", reason: null, runId: "run", runStatus, startedAt: null })).toBe(false);
  });
  it.each(["queued", "deferred_issue_execution", "coalesced", "completed"])("does not replace an unproven %s receipt without a run", (status) => {
    expect(isUndeliveredTerminalReceipt({ status, reason: null, runId: null, runStatus: null, startedAt: null })).toBe(false);
  });
  it("recognizes a retired undelivered source receipt when resolving a merged delivery", () => {
    expect(isUndeliveredTerminalReceipt({ status: "skipped", reason: "delivery_undelivered_terminal", runId: null, runStatus: null, startedAt: null })).toBe(true);
  });
  it.each([
    ["heartbeat.disabled", "Scheduled agent wakeups are disabled"],
    ["heartbeat.wakeOnDemand.disabled", "On-demand agent wakeups are disabled"],
    ["issue_tree_hold_active", "subtree hold"],
    ["issue_execution_issue_not_found", "source issue was not found"],
    ["issue_dependencies_blocked", "unresolved dependencies"],
    ["future_skip_reason", "future_skip_reason"],
  ])("keeps skipped %s delivery pending", (reason, message) => {
    const delivery = classifyWakeupDelivery({ status: "skipped", reason, runStatus: null, startedAt: null });
    expect(delivery.status).toBe("pending");
    expect(delivery.reason).toContain(message);
  });
  it.each(["deferred_issue_execution", "coalesced", "queued", "cancelled", "failed"])("keeps unqueued %s receipts pending", (status) => {
    expect(classifyWakeupDelivery({ status, reason: null, runStatus: null, startedAt: null }).status).toBe("pending");
  });
  it.each(["cancelled", "scheduled_retry", "failed"])("keeps a %s run pending when it never started", (runStatus) => {
    expect(classifyWakeupDelivery({ status: "queued", reason: null, runStatus, startedAt: null }).status).toBe("pending");
  });
  it("does not claim delivery without a receipt", () => expect(classifyWakeupDelivery(null).status).toBe("pending"));
  it.each(["queued", "running"])("accepts a receipt with a %s run", (runStatus) => {
    expect(classifyWakeupDelivery({ status: "queued", reason: null, runStatus, startedAt: null })).toEqual({ status: "accepted" });
  });
  it.each(["succeeded", "failed", "cancelled", "timed_out"])("keeps an already started %s run accepted on duplicate retries", (runStatus) => {
    expect(classifyWakeupDelivery({ status: "completed", reason: null, runStatus, startedAt: new Date() })).toEqual({ status: "accepted" });
  });
});
