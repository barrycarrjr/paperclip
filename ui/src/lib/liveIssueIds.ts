import type { LiveRunForIssue } from "../api/heartbeats";

export function isLiveRunStatus(status: string): boolean {
  return status === "queued" || status === "running";
}

/**
 * Statuses a run can never leave. Note scheduled_retry is NOT terminal:
 * the same run row is promoted back to queued when its retry time comes.
 */
export const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

export function collectLiveIssueIds(liveRuns: readonly LiveRunForIssue[] | null | undefined): Set<string> {
  const ids = new Set<string>();
  for (const run of liveRuns ?? []) {
    if (run.issueId && isLiveRunStatus(run.status)) ids.add(run.issueId);
  }
  return ids;
}
