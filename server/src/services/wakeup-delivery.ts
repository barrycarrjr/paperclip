export interface WakeupDeliveryReceipt {
  status: string;
  reason: string | null;
  runStatus: string | null;
  startedAt: Date | null;
}

export function isUndeliveredTerminalReceipt(receipt: WakeupDeliveryReceipt & { runId: string | null }): boolean {
  if (receipt.startedAt) return false;
  if (receipt.runId) return receipt.runStatus === "cancelled" || receipt.runStatus === "failed" || receipt.runStatus === "timed_out";
  return receipt.status === "cancelled" || receipt.status === "failed" || (receipt.status === "skipped" && receipt.reason === "delivery_undelivered_terminal");
}

export function classifyWakeupDelivery(receipt: WakeupDeliveryReceipt | null): { status: "accepted" | "pending"; reason?: string } {
  if (!receipt) return { status: "pending", reason: "The host has not confirmed a queued agent run for this correction." };
  if (receipt.status !== "skipped" && (receipt.startedAt || receipt.runStatus === "queued" || receipt.runStatus === "running")) return { status: "accepted" };
  const skippedReasons: Record<string, string> = {
    "heartbeat.disabled": "Scheduled agent wakeups are disabled.",
    "heartbeat.wakeOnDemand.disabled": "On-demand agent wakeups are disabled. Enable them before retrying correction delivery.",
    issue_tree_hold_active: "The issue is paused by an active subtree hold.",
    issue_execution_issue_not_found: "The source issue was not found when delivery was attempted.",
    issue_dependencies_blocked: "The source issue has unresolved dependencies.",
  };
  if (receipt.status === "skipped") return { status: "pending", reason: skippedReasons[receipt.reason ?? ""] ?? `The host skipped agent delivery (${receipt.reason ?? "unspecified reason"}).` };
  if (receipt.status === "deferred_issue_execution" || (receipt.status === "coalesced" && !receipt.runStatus)) return { status: "pending", reason: "Correction delivery is waiting for the current issue execution to finish." };
  return { status: "pending", reason: receipt.runStatus ? `Correction delivery has no active queued run (run status: ${receipt.runStatus}).` : `Correction delivery has no confirmed queued run (request status: ${receipt.status}).` };
}
