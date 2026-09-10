import type { HeartbeatRun } from "@paperclipai/shared";

/**
 * How one team member has actually been getting on lately, worked out from
 * its own run history.
 *
 * Every figure here is counted from runs the app already stores, over a
 * window that is stated on screen rather than implied. Nothing is estimated
 * and nothing is shown when there is nothing to count: a member with no
 * finished runs in the window gets nulls, and the panel says so in words
 * instead of printing a confident 0%.
 *
 * Two deliberate choices worth knowing about:
 *
 * A run somebody stopped by hand is not a failure. It is counted on its own
 * so that stopping a run that was going nowhere does not quietly make a
 * member's success rate look worse.
 *
 * The duration reported is the middle run, not the average. One run that sat
 * waiting on a rate limit for four hours drags an average somewhere no run
 * has ever actually been, and the question this answers is "how long does
 * this normally take".
 */

export const AGENT_HEALTH_WINDOW_DAYS = 7;

export interface AgentHealth {
  /** How far back the figures look. */
  windowDays: number;
  /** Runs that started in the window, whatever became of them. */
  total: number;
  succeeded: number;
  /** Failed or timed out. */
  failed: number;
  /** Cancelled by a person. Not counted as a failure. */
  stopped: number;
  /** Still going right now. */
  live: number;
  /**
   * Succeeded as a share of the runs that reached an end on their own,
   * between 0 and 1. Null when none did, so the caller says "not enough to
   * go on" rather than "0%".
   */
  successRate: number | null;
  /** The middle finished run's length in milliseconds, or null. */
  typicalDurationMs: number | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
}

const SUCCESS_STATUSES = new Set(["succeeded"]);
const FAILURE_STATUSES = new Set(["failed", "timed_out"]);
const STOPPED_STATUSES = new Set(["cancelled"]);
const LIVE_STATUSES = new Set(["running", "queued", "scheduled_retry"]);

function msOf(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function isoOf(value: Date | string | null | undefined): string | null {
  const ms = msOf(value);
  return ms === null ? null : new Date(ms).toISOString();
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

export function summarizeAgentHealth(
  runs: HeartbeatRun[],
  options?: { now?: number; windowDays?: number },
): AgentHealth {
  const now = options?.now ?? Date.now();
  const windowDays = options?.windowDays ?? AGENT_HEALTH_WINDOW_DAYS;
  const since = now - windowDays * 24 * 60 * 60_000;

  let total = 0;
  let succeeded = 0;
  let failed = 0;
  let stopped = 0;
  let live = 0;
  let lastSuccessAt: string | null = null;
  let lastFailureAt: string | null = null;
  const durations: number[] = [];

  for (const run of runs) {
    const started = msOf(run.startedAt) ?? msOf(run.createdAt);
    if (started === null || started < since) continue;
    total += 1;

    if (LIVE_STATUSES.has(run.status)) {
      live += 1;
      continue;
    }

    const finished = msOf(run.finishedAt);
    if (finished !== null && finished > started) durations.push(finished - started);

    if (SUCCESS_STATUSES.has(run.status)) {
      succeeded += 1;
      const at = isoOf(run.finishedAt) ?? isoOf(run.startedAt);
      if (at && (!lastSuccessAt || at > lastSuccessAt)) lastSuccessAt = at;
    } else if (FAILURE_STATUSES.has(run.status)) {
      failed += 1;
      const at = isoOf(run.finishedAt) ?? isoOf(run.startedAt);
      if (at && (!lastFailureAt || at > lastFailureAt)) lastFailureAt = at;
    } else if (STOPPED_STATUSES.has(run.status)) {
      stopped += 1;
    }
  }

  const decided = succeeded + failed;

  return {
    windowDays,
    total,
    succeeded,
    failed,
    stopped,
    live,
    successRate: decided > 0 ? succeeded / decided : null,
    typicalDurationMs: median(durations),
    lastSuccessAt,
    lastFailureAt,
  };
}

/** "94%" or "not enough to go on". */
export function formatSuccessRate(rate: number | null): string {
  if (rate === null) return "not enough to go on";
  return `${Math.round(rate * 100)}%`;
}
