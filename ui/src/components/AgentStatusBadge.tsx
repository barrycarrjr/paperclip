import { StatusBadge } from "./StatusBadge";
import {
  personWaitingState,
  TEAM_WORK_STATE_DESCRIPTIONS,
  TEAM_WORK_STATE_LABELS,
  type TeamWorkState,
} from "../lib/team-current-work";
import { teamWorkStateBadge, teamWorkStateDot, teamWorkStateDotDefault } from "../lib/status-colors";
import { cn } from "../lib/utils";

/**
 * The Team page's pill for one of its "right now" states, with the dot and
 * the one-sentence meaning on hover.
 */
export function TeamWorkStateBadge({
  state,
  className,
}: {
  state: TeamWorkState;
  className?: string;
}) {
  return (
    <span
      title={TEAM_WORK_STATE_DESCRIPTIONS[state]}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium",
        teamWorkStateBadge[state] ?? "bg-muted text-muted-foreground",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block h-1.5 w-1.5 rounded-full",
          teamWorkStateDot[state] ?? teamWorkStateDotDefault,
        )}
      />
      {TEAM_WORK_STATE_LABELS[state]}
    </span>
  );
}

/**
 * An agent's status badge that does not call an agent "idle" while it is
 * waiting on you.
 *
 * The stored status only knows whether a run is going. When the Team page's
 * own reading says the agent asked a question or handed work back, that is
 * shown instead, in the same words and colours as the Team page. Anything
 * else, or no reading at all, falls back to the stored status as before.
 */
export function AgentStatusBadge({
  status,
  workState,
}: {
  status: string;
  workState: TeamWorkState | null | undefined;
}) {
  const waiting = personWaitingState(workState);
  if (waiting) {
    // Sized like StatusBadge so the header does not jump when it switches.
    return <TeamWorkStateBadge state={waiting} className="px-2.5 text-xs" />;
  }
  return <StatusBadge status={status} />;
}
