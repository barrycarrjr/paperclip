import { useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { ArrowDown, ArrowUp, Bot, ChevronsUpDown } from "lucide-react";
import { AGENT_ROLE_LABELS } from "@paperclipai/shared";
import { AgentIcon } from "./AgentIconPicker";
import { TeamMemberControls } from "./TeamMemberControls";
import type { TeamMemberActions } from "../hooks/useTeamMemberActions";
import { getAdapterLabel } from "../adapters/adapter-display-registry";
import { RUN_NOW_LINE_TONE_CLASSES } from "../lib/run-now-line";
import {
  TEAM_WORK_STATE_DESCRIPTIONS,
  TEAM_WORK_STATE_LABELS,
  type TeamAgentWork,
} from "../lib/team-current-work";
import {
  teamWorkStateBadge,
  teamWorkStateDot,
  teamWorkStateDotDefault,
} from "../lib/status-colors";
import { agentUrl, cn, relativeTime } from "../lib/utils";
import { formatElapsed } from "../lib/clippy-tool-labels";

const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

/**
 * The same rows as the cards, one line each.
 *
 * This is the view that stays usable when the team is large enough that
 * cards stop fitting on a screen, so it carries exactly the same facts and
 * exactly the same controls rather than a reduced set. The only thing it
 * adds is sorting, because a long list is the only place sorting earns its
 * keep.
 *
 * Sorting by status uses the order the rows already arrive in, which puts
 * the ones waiting on a person first. That is more useful than alphabetical
 * status names, and it means the default table and the default card grid
 * agree with each other.
 */

type SortKey = "member" | "status" | "activity";
type SortDirection = "asc" | "desc";

export function TeamMemberTable({
  rows,
  actions,
  nowMs,
}: {
  rows: TeamAgentWork[];
  actions: TeamMemberActions;
  nowMs: number;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("status");
  const [direction, setDirection] = useState<SortDirection>("asc");

  const sorted = useMemo(() => {
    // rows arrive already ordered by urgency then name; index preserves that
    // as the meaning of "sort by status".
    const order = new Map(rows.map((row, index) => [row.agent.id, index]));
    const copy = [...rows];
    copy.sort((a, b) => {
      let result: number;
      if (sortKey === "member") {
        result = a.agent.name.localeCompare(b.agent.name);
      } else if (sortKey === "activity") {
        const at = a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0;
        const bt = b.lastActivityAt ? new Date(b.lastActivityAt).getTime() : 0;
        // Plain oldest-first, so the arrow on the heading always means what
        // it looks like it means. The useful direction, most recent first, is
        // what a first click on this column selects (see toggle below).
        result = at - bt;
      } else {
        result = (order.get(a.agent.id) ?? 0) - (order.get(b.agent.id) ?? 0);
      }
      return direction === "asc" ? result : -result;
    });
    return copy;
  }, [rows, sortKey, direction]);

  const toggle = (key: SortKey) => {
    if (key === sortKey) {
      setDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    // Times start on their useful end. Asking to sort by last activity means
    // "who moved most recently" far more often than the reverse, and starting
    // there costs nobody the other direction, which is one more click.
    setDirection(key === "activity" ? "desc" : "asc");
  };

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[52rem] text-sm">
        <thead>
          <tr className="border-b border-border bg-accent/20 text-left">
            <SortableHeader
              label="Team member"
              active={sortKey === "member"}
              direction={direction}
              onClick={() => toggle("member")}
            />
            <SortableHeader
              label="Status"
              active={sortKey === "status"}
              direction={direction}
              onClick={() => toggle("status")}
            />
            <th className="px-3 py-2 text-xs font-medium text-muted-foreground">
              What it is doing
            </th>
            <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Current task</th>
            <SortableHeader
              label="Last activity"
              active={sortKey === "activity"}
              direction={direction}
              onClick={() => toggle("activity")}
            />
            <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Runs on</th>
            <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <TeamMemberTableRow key={row.agent.id} row={row} actions={actions} nowMs={nowMs} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SortableHeader({
  label,
  active,
  direction,
  onClick,
}: {
  label: string;
  active: boolean;
  direction: SortDirection;
  onClick: () => void;
}) {
  const Icon = !active ? ChevronsUpDown : direction === "asc" ? ArrowUp : ArrowDown;
  return (
    <th className="px-3 py-2 text-xs font-medium text-muted-foreground">
      <button
        type="button"
        onClick={onClick}
        aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}
        className={cn(
          "inline-flex items-center gap-1 transition-colors hover:text-foreground",
          active && "text-foreground",
        )}
      >
        {label}
        <Icon className="h-3 w-3" />
      </button>
    </th>
  );
}

function TeamMemberTableRow({
  row,
  actions,
  nowMs,
}: {
  row: TeamAgentWork;
  actions: TeamMemberActions;
  nowMs: number;
}) {
  const { agent } = row;
  const roleLabel = roleLabels[agent.role] ?? agent.role;
  const startedMs = row.runStartedAt ? new Date(row.runStartedAt).getTime() : null;
  const taskHref = row.task ? `/issues/${row.task.identifier ?? row.task.issueId}` : null;

  return (
    <tr className="border-b border-border align-top last:border-b-0 hover:bg-accent/20">
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded bg-muted/60">
            {agent.icon ? (
              <AgentIcon icon={agent.icon} className="h-3.5 w-3.5" />
            ) : (
              <Bot className="h-3 w-3 text-muted-foreground" />
            )}
          </span>
          <div className="min-w-0">
            <Link to={agentUrl(agent)} className="block truncate font-medium hover:underline">
              {agent.name}
            </Link>
            <span className="block truncate text-xs text-muted-foreground">{roleLabel}</span>
          </div>
        </div>
      </td>

      <td className="px-3 py-2.5">
        <span
          title={TEAM_WORK_STATE_DESCRIPTIONS[row.state]}
          className={cn(
            "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium",
            teamWorkStateBadge[row.state] ?? "bg-muted text-muted-foreground",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "inline-block h-1.5 w-1.5 rounded-full",
              teamWorkStateDot[row.state] ?? teamWorkStateDotDefault,
            )}
          />
          {TEAM_WORK_STATE_LABELS[row.state]}
        </span>
      </td>

      <td className="max-w-[18rem] px-3 py-2.5">
        <p className="text-xs text-foreground">{row.line}</p>
        {row.detail && (
          <p
            className={cn(
              "text-xs",
              row.detailTone ? RUN_NOW_LINE_TONE_CLASSES[row.detailTone] : "text-muted-foreground",
            )}
          >
            {row.detail}
          </p>
        )}
        {startedMs !== null && Number.isFinite(startedMs) && (
          <p className="text-[11px] text-muted-foreground">
            {formatElapsed(nowMs - startedMs)} so far
          </p>
        )}
      </td>

      <td className="max-w-[16rem] px-3 py-2.5">
        {taskHref && row.task ? (
          <Link to={taskHref} className="group block min-w-0 text-xs">
            {row.task.identifier && (
              <span className="font-mono text-muted-foreground">{row.task.identifier}</span>
            )}
            <span className="block truncate text-muted-foreground group-hover:text-foreground group-hover:underline">
              {row.task.title}
            </span>
          </Link>
        ) : (
          <span className="text-xs text-muted-foreground">-</span>
        )}
      </td>

      <td className="whitespace-nowrap px-3 py-2.5 text-xs text-muted-foreground">
        {row.lastActivityAt ? relativeTime(row.lastActivityAt) : "-"}
      </td>

      <td className="whitespace-nowrap px-3 py-2.5 text-xs text-muted-foreground">
        {getAdapterLabel(agent.adapterType)}
      </td>

      <td className="px-3 py-2.5">
        <div className="flex justify-end">
          <TeamMemberControls row={row} actions={actions} size="xs" />
        </div>
      </td>
    </tr>
  );
}
