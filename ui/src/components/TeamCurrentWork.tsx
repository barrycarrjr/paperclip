import { useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { Bot } from "lucide-react";
import { AGENT_ROLE_LABELS } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { agentUrl, agentRouteRef, cn } from "../lib/utils";
import {
  buildTeamCurrentWork,
  countTeamWorkStates,
  TEAM_WORK_STATE_DESCRIPTIONS,
  TEAM_WORK_STATE_LABELS,
  type TeamAgentWork,
  type TeamWorkState,
} from "../lib/team-current-work";
import { agentStatusDot, agentStatusDotDefault, teamWorkStateBadge } from "../lib/status-colors";
import { EmptyState } from "./EmptyState";
import { LiveRunIndicator } from "./LiveRunIndicator";
import { PageSkeleton } from "./PageSkeleton";

const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

/** Same refresh cadence as the agent list's live-run badge. */
const LIVE_RUN_REFRESH_MS = 15_000;

/** How many pending questions to read. Matches the Attention page's ceiling. */
const PENDING_QUESTION_LIMIT = 50;

const FILTER_ORDER: TeamWorkState[] = [
  "needs_you",
  "working",
  "retrying",
  "error",
  "paused",
  "waiting",
  "quiet",
];

/**
 * The Team page's opening view: one line per agent saying what it is doing
 * right now, with everything else about that agent one click away on its own
 * page. See lib/team-current-work.ts for where each sentence comes from.
 */
export function TeamCurrentWork({ companyId }: { companyId: string }) {
  const [filter, setFilter] = useState<TeamWorkState | "all">("all");

  const { data: agents, isLoading, error } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });

  const { data: liveRuns } = useQuery({
    queryKey: [...queryKeys.liveRuns(companyId), "team-current-work"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId),
    refetchInterval: LIVE_RUN_REFRESH_MS,
  });

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(companyId),
    queryFn: () => issuesApi.list(companyId),
  });

  const { data: pendingInteractions } = useQuery({
    queryKey: [...queryKeys.issues.list(companyId), "pending-interactions", PENDING_QUESTION_LIMIT],
    queryFn: () => issuesApi.listPendingInteractions(companyId, PENDING_QUESTION_LIMIT),
  });

  const rows = useMemo(
    () =>
      buildTeamCurrentWork({
        agents: agents ?? [],
        liveRuns: liveRuns ?? [],
        issues: issues ?? [],
        pendingInteractions: pendingInteractions ?? [],
      }),
    [agents, liveRuns, issues, pendingInteractions],
  );

  const counts = useMemo(() => countTeamWorkStates(rows), [rows]);
  const visible = filter === "all" ? rows : rows.filter((row) => row.state === filter);

  if (isLoading) return <PageSkeleton variant="list" />;

  if (error) {
    return <p className="text-sm text-destructive">{error.message}</p>;
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Bot}
        message="No agents in this company yet. Once there are, this is where you see what each one is doing."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <FilterChip
          label="Everyone"
          count={rows.length}
          active={filter === "all"}
          onClick={() => setFilter("all")}
        />
        {FILTER_ORDER.filter((state) => counts[state] > 0).map((state) => (
          <FilterChip
            key={state}
            label={TEAM_WORK_STATE_LABELS[state]}
            title={TEAM_WORK_STATE_DESCRIPTIONS[state]}
            count={counts[state]}
            active={filter === state}
            onClick={() => setFilter(state)}
          />
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No agent is in that state right now.
        </p>
      ) : (
        <div className="border border-border">
          {visible.map((row) => (
            <TeamWorkRow key={row.agent.id} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterChip({
  label,
  count,
  active,
  title,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 border border-border px-2 py-1 text-xs transition-colors",
        active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50",
      )}
    >
      {label}
      <span className="text-[10px] tabular-nums opacity-70">{count}</span>
    </button>
  );
}

function TeamWorkRow({ row }: { row: TeamAgentWork }) {
  const { agent, task } = row;
  const roleLabel = roleLabels[agent.role] ?? agent.role;

  return (
    <div className="flex items-start gap-3 border-b border-border px-4 py-3 text-sm last:border-b-0">
      <span className="mt-1.5 flex h-2.5 w-2.5 shrink-0">
        <span
          className={cn(
            "inline-flex h-full w-full rounded-full",
            agentStatusDot[agent.status] ?? agentStatusDotDefault,
          )}
        />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <Link to={agentUrl(agent)} className="font-medium text-foreground hover:underline">
            {agent.name}
          </Link>
          <span className="text-xs text-muted-foreground">
            {roleLabel}
            {agent.title ? ` - ${agent.title}` : ""}
          </span>
        </div>

        <p className="mt-0.5 text-xs text-muted-foreground">
          {row.line}
          {row.detail ? ` ${row.detail}` : ""}
        </p>

        {task && (
          <Link
            to={`/issues/${task.identifier ?? task.issueId}`}
            className="mt-1 inline-flex max-w-full items-baseline gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            {task.identifier && <span className="font-mono shrink-0">{task.identifier}</span>}
            <span className="truncate">{task.title}</span>
          </Link>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {row.runId && (
          <LiveRunIndicator agentRef={agentRouteRef(agent)} runId={row.runId} liveCount={1} />
        )}
        <span
          title={TEAM_WORK_STATE_DESCRIPTIONS[row.state]}
          className={cn(
            "inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium",
            teamWorkStateBadge[row.state] ?? "bg-muted text-muted-foreground",
          )}
        >
          {TEAM_WORK_STATE_LABELS[row.state]}
        </span>
      </div>
    </div>
  );
}
