import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { agents, environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";

// The heartbeat service never starts a run for an agent in one of these states.
const NON_INVOKABLE_AGENT_STATUSES = ["paused", "terminated", "pending_approval"];

/**
 * Wait until no heartbeat run is still working, so a test's cleanup cannot
 * delete rows that a run is about to write.
 *
 * The heartbeat service starts each run in the background and gives the caller
 * nothing to wait on. A run's row also turns terminal before the run is done
 * with the database: after setting its status the run still writes the issue's
 * continuation summary document, posts its comment, releases the issue and can
 * queue a follow-up run, and only then sets its agent back from "running" and
 * releases its environment lease. Waiting for runs to stop being queued or
 * running is therefore not enough. A cleanup that did only that deleted a
 * company that a moment later gained a document revision, and failed on the
 * foreign key.
 *
 * So the work counts as finished only when no run this process will pick up is
 * queued or running, no agent is still marked running, and no environment lease
 * is still held.
 *
 * Only run rows are let off. A run of a paused, terminated or pending agent is
 * never started, and a run with a recorded process belongs to that process, so
 * both are ignored. Anything else a test leaves looking busy holds this up until
 * it times out and throws: an agent seeded as "running", a lease seeded as
 * "active", or a queued run waiting behind an ignored run of the same task (the
 * service never runs two runs of one task side by side).
 *
 * Some writes come after all three signals have cleared, so this cannot see them:
 * - the activity row that records a lease's release, written straight after the
 *   lease changes. Harmless in practice: it lands at once, and if cleanup has
 *   already deleted what it points at, the insert fails and is ignored.
 * - the writes made when a run's end goes to start the next queued run and
 *   cancels it instead (startNextQueuedRunForAgent): the cancelled run's row
 *   turns terminal first and the rest of the cancellation follows.
 * - a run that fails in setup before it takes its environment lease. Its error
 *   handling marks the row failed and then writes the continuation summary,
 *   with no lease held and its agent never marked running.
 * Leave a short margin after this call for those.
 *
 * Call it before cleanup changes anything: marking a run cancelled while it is
 * still executing hides it from this check without stopping it.
 */
export async function waitForHeartbeatRunsToFinish(db: Db, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [activeRuns, runningAgents, heldLeases] = await Promise.all([
      db
        .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
        .where(
          and(
            inArray(heartbeatRuns.status, ["queued", "running"]),
            isNull(heartbeatRuns.processPid),
            isNull(heartbeatRuns.processGroupId),
            notInArray(agents.status, NON_INVOKABLE_AGENT_STATUSES),
          ),
        ),
      db.select({ id: agents.id }).from(agents).where(eq(agents.status, "running")),
      db
        .select({ id: environmentLeases.id, runId: environmentLeases.heartbeatRunId })
        .from(environmentLeases)
        .where(eq(environmentLeases.status, "active")),
    ]);
    if (activeRuns.length === 0 && runningAgents.length === 0 && heldLeases.length === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Heartbeat runs still working after ${timeoutMs}ms: ` +
          `runs ${JSON.stringify(activeRuns)}, running agents ${JSON.stringify(runningAgents)}, ` +
          `held environment leases ${JSON.stringify(heldLeases)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
