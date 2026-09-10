import type { ActivityEvent } from "@paperclipai/shared";

/**
 * Which of an agent's recorded events are worth a person's attention.
 *
 * The company activity record holds two different kinds of entry. Some are
 * things the agent did that changed the work: it took a task, commented,
 * moved a status, produced something. Others are the machinery moving
 * underneath: a workspace being borrowed and given back around every single
 * run.
 *
 * On a whole-company feed the second kind is harmless. On one agent's own
 * page it is not: an agent that ran four times contributes eight
 * lease entries, which is enough to push every real event off the panel. The
 * server already draws this exact line for its own purposes and calls those
 * actions bookkeeping (LIVENESS_BOOKKEEPING_ACTIVITY_ACTIONS in
 * server/src/services/heartbeat.ts); this is the same judgement applied to
 * what gets shown.
 *
 * Nothing is deleted and nothing is hidden from the Activity page, which
 * still shows everything. This only decides what leads.
 */

/**
 * Actions that record the machinery rather than the work. Kept as a list
 * rather than a pattern so adding one is a deliberate decision with a name
 * attached, not a regex quietly swallowing something new.
 */
export const AGENT_BOOKKEEPING_ACTIONS: readonly string[] = [
  "environment.lease_acquired",
  "environment.lease_released",
];

export function isAgentBookkeepingEvent(event: Pick<ActivityEvent, "action">): boolean {
  return AGENT_BOOKKEEPING_ACTIONS.includes(event.action);
}

/**
 * The events to show on an agent's own page, newest first, capped.
 *
 * If filtering would leave the panel almost empty, the bookkeeping goes back
 * in rather than showing a page that reads as "this agent has done nothing".
 * An agent whose only recorded events ARE leases has genuinely done nothing
 * else, and saying so with an empty panel would be less honest than showing
 * what there is.
 */
export function agentActivityToShow<T extends Pick<ActivityEvent, "action">>(
  events: T[],
  limit: number,
): T[] {
  const meaningful = events.filter((event) => !isAgentBookkeepingEvent(event));
  if (meaningful.length === 0) return events.slice(0, limit);
  return meaningful.slice(0, limit);
}
