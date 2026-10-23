import type { Approval } from "@paperclipai/shared";
import { approvalsApi } from "../api/approvals";

/**
 * Whether an approval can be decided straight from a list, one at a time or
 * as part of a bulk selection. A budget override has its own flow on the
 * detail page, and anything already decided has nothing left to decide.
 */
export function isBulkResolvable(approval: Pick<Approval, "type" | "status">): boolean {
  return (
    approval.type !== "budget_override_required" &&
    (approval.status === "pending" || approval.status === "revision_requested")
  );
}

export type BulkApprovalAction = "approve" | "reject";

export interface BulkApprovalResult {
  succeeded: string[];
  failed: { id: string; message: string }[];
}

/**
 * Approve or reject every id, carrying on past failures so one bad request
 * does not leave the rest undecided. The caller reports what failed.
 */
export async function resolveApprovalsInBulk(
  ids: string[],
  action: BulkApprovalAction,
  api: Pick<typeof approvalsApi, "approve" | "reject"> = approvalsApi,
): Promise<BulkApprovalResult> {
  const settled = await Promise.allSettled(
    ids.map((id) => (action === "approve" ? api.approve(id) : api.reject(id))),
  );
  const result: BulkApprovalResult = { succeeded: [], failed: [] };
  settled.forEach((outcome, index) => {
    const id = ids[index]!;
    if (outcome.status === "fulfilled") {
      result.succeeded.push(id);
    } else {
      const reason = outcome.reason;
      result.failed.push({ id, message: reason instanceof Error ? reason.message : String(reason) });
    }
  });
  return result;
}

/** One line for the page to show when some of a bulk action failed. */
export function bulkFailureMessage(result: BulkApprovalResult, action: BulkApprovalAction): string | null {
  if (result.failed.length === 0) return null;
  const verb = action === "approve" ? "approve" : "reject";
  const total = result.failed.length + result.succeeded.length;
  const first = result.failed[0]!.message;
  return `Could not ${verb} ${result.failed.length} of ${total}: ${first}`;
}
