import { AlertCircle, Users, Activity, Pause, Moon } from "lucide-react";
import { MetricCard } from "./MetricCard";
import {
  countTeamWorkStates,
  TEAM_STATE_GROUP_STATES,
  type TeamAgentWork,
  type TeamStateGroup,
  type TeamWorkState,
} from "../lib/team-current-work";

/**
 * The five numbers across the top of the Team page.
 *
 * Each one is a filter as well as a count: clicking a tile narrows the list
 * below to exactly the rows it counted, and clicking it again clears the
 * filter. That is why they are tiles rather than plain text, and it is the
 * whole reason the summary earns the space it takes.
 *
 * "Needs you" deliberately spans three states rather than one. A question
 * waiting for an answer, finished work waiting for a look and an agent
 * stopped with an error are three different situations, but they are the
 * same instruction to the person reading: this will not move until you do
 * something. Splitting them across three tiles would bury that.
 */

/**
 * The group of states one tile stands for. The four real groups are defined
 * once in lib/team-current-work.ts, because an executive's roll-up and the
 * branch headings count by the same groups and must not be able to disagree
 * with the tiles. "all" is the tiles' own extra: the tile that clears the
 * filter rather than narrowing it.
 */
export type TeamSummaryGroup = TeamStateGroup | "all";

export const TEAM_SUMMARY_GROUP_STATES: Record<TeamStateGroup, readonly TeamWorkState[]> =
  TEAM_STATE_GROUP_STATES;

export function teamSummaryGroupMatches(group: TeamSummaryGroup, state: TeamWorkState): boolean {
  if (group === "all") return true;
  return TEAM_SUMMARY_GROUP_STATES[group].includes(state);
}

export function TeamSummaryTiles({
  rows,
  active,
  onPick,
}: {
  rows: TeamAgentWork[];
  active: TeamSummaryGroup;
  onPick: (group: TeamSummaryGroup) => void;
}) {
  const counts = countTeamWorkStates(rows);
  const sum = (states: readonly TeamWorkState[]) =>
    states.reduce((total, state) => total + counts[state], 0);

  const attention = sum(TEAM_SUMMARY_GROUP_STATES.attention);
  const working = sum(TEAM_SUMMARY_GROUP_STATES.working);
  const paused = sum(TEAM_SUMMARY_GROUP_STATES.paused);
  const idle = sum(TEAM_SUMMARY_GROUP_STATES.idle);

  // Clicking the tile that is already on clears the filter, so the tiles
  // never trap you in a narrowed list with no obvious way back.
  const pick = (group: TeamSummaryGroup) => () =>
    onPick(active === group ? "all" : group);

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <MetricCard
        icon={AlertCircle}
        value={attention}
        label="Needs you"
        description="Questions, finished work and errors waiting on a person"
        tone={attention > 0 ? "danger" : "default"}
        emphasis={active === "attention"}
        onClick={pick("attention")}
      />
      <MetricCard
        icon={Activity}
        value={working}
        label="Working"
        description="A run is going right now"
        tone={working > 0 ? "success" : "default"}
        emphasis={active === "working"}
        onClick={pick("working")}
      />
      <MetricCard
        icon={Pause}
        value={paused}
        label="Paused"
        description="Will not pick anything up"
        tone={paused > 0 ? "warning" : "default"}
        emphasis={active === "paused"}
        onClick={pick("paused")}
      />
      <MetricCard
        icon={Moon}
        value={idle}
        label="Idle"
        description="Nothing running, waiting on a schedule or on work"
        emphasis={active === "idle"}
        onClick={pick("idle")}
      />
      <MetricCard
        icon={Users}
        value={rows.length}
        label="Team"
        description="Everyone in this company"
        emphasis={active === "all"}
        onClick={pick("all")}
      />
    </div>
  );
}
