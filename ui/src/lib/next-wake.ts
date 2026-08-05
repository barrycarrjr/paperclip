/**
 * When will this agent's scheduler next wake it? Mirrors the server's
 * heartbeat.tickTimers rule: baseline is the last heartbeat (or creation),
 * due after heartbeatIntervalSec. Returns null when the agent is not on a
 * schedule (scheduler inactive, no interval, or fields absent because the
 * server predates them). Dates are typed loosely because they arrive as
 * JSON strings despite the shared type saying Date.
 */
export function nextWakeAtMs(agent: {
  schedulerActive?: boolean;
  heartbeatIntervalSec?: number;
  lastHeartbeatAt?: string | Date | null;
  createdAt?: string | Date | null;
}): number | null {
  if (agent.schedulerActive !== true) return null;
  const intervalSec = agent.heartbeatIntervalSec ?? 0;
  if (intervalSec <= 0) return null;
  const baselineRaw = agent.lastHeartbeatAt ?? agent.createdAt;
  if (!baselineRaw) return null;
  const baseline = new Date(baselineRaw).getTime();
  if (!Number.isFinite(baseline)) return null;
  return baseline + intervalSec * 1000;
}

/**
 * "wakes in 22m", "wakes in 3h 05m", or "waking soon" once the due time has
 * passed (the scheduler fires on its next sweep, so "overdue" is normal for
 * a short while and should not read as a problem). Past a short grace
 * window the label reports the overdue honestly instead of promising
 * "waking soon" forever on a stuck scheduler.
 */
const OVERDUE_GRACE_MS = 2 * 60_000;

export function formatNextWake(nextWakeMs: number, now: number): string {
  const remainingMs = nextWakeMs - now;
  if (remainingMs <= -OVERDUE_GRACE_MS) {
    const overdueMin = Math.ceil(-remainingMs / 60_000);
    if (overdueMin < 60) return `wake overdue by ${overdueMin}m`;
    const hours = Math.floor(overdueMin / 60);
    return `wake overdue by ${hours}h`;
  }
  if (remainingMs <= 0) return "waking soon";
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  if (minutes < 60) return `wakes in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (hours < 24) {
    return rem > 0
      ? `wakes in ${hours}h ${String(rem).padStart(2, "0")}m`
      : `wakes in ${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return `wakes in ${days}d ${hours % 24}h`;
}
