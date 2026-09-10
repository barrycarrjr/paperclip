import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, LayoutGrid, Rows3, Search, X } from "lucide-react";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import {
  buildTeamCurrentWork,
  countTeamWorkStates,
  TEAM_WORK_STATE_DESCRIPTIONS,
  TEAM_WORK_STATE_LABELS,
  type TeamAgentWork,
  type TeamWorkState,
} from "../lib/team-current-work";
import { EmptyState } from "./EmptyState";
import { PageSkeleton } from "./PageSkeleton";
import { TeamMemberCard } from "./TeamMemberCard";
import { TeamMemberTable } from "./TeamMemberTable";
import { useTeamMemberActions } from "../hooks/useTeamMemberActions";
import {
  TeamSummaryTiles,
  teamSummaryGroupMatches,
  type TeamSummaryGroup,
} from "./TeamSummaryTiles";
import { useNowTick } from "../hooks/useNowTick";
import { AGENT_ROLE_LABELS } from "@paperclipai/shared";

const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

/** Same refresh cadence as the agent list's live-run badge. */
const LIVE_RUN_REFRESH_MS = 15_000;

/** How many pending questions to read. Matches the Attention page's ceiling. */
const PENDING_QUESTION_LIMIT = 50;

/**
 * How often the elapsed-time readouts re-draw. A run's age only needs to be
 * right to the nearest few seconds on a page showing a whole team, and a
 * one-second tick would re-render every card in the grid for nothing.
 */
const CLOCK_TICK_MS = 15_000;

/** Which view the person last chose, so it survives leaving the page. */
const VIEW_STORAGE_KEY = "paperclip.team.view";

const FILTER_ORDER: TeamWorkState[] = [
  "needs_you",
  "needs_review",
  "working",
  "retrying",
  "error",
  "paused",
  "waiting",
  "quiet",
];

type TeamView = "cards" | "table";

/**
 * One filter, not two. The summary tiles pick a group of states and the
 * chips pick a single state, but only one of them can be on at a time,
 * because a page that quietly held both would show a list neither control
 * explained.
 */
type TeamFilter =
  | { kind: "all" }
  | { kind: "group"; group: TeamSummaryGroup }
  | { kind: "state"; state: TeamWorkState };

function readStoredView(): TeamView {
  if (typeof window === "undefined") return "cards";
  return window.localStorage.getItem(VIEW_STORAGE_KEY) === "table" ? "table" : "cards";
}

/** Free-text search across the things a person would actually type. */
function matchesSearch(row: TeamAgentWork, needle: string): boolean {
  if (!needle) return true;
  const haystack = [
    row.agent.name,
    row.agent.title ?? "",
    // Both the stored role and the words actually printed on the card, so
    // typing what you can see finds the row.
    row.agent.role,
    roleLabels[row.agent.role] ?? "",
    row.line,
    row.detail ?? "",
    row.task?.title ?? "",
    row.task?.identifier ?? "",
    TEAM_WORK_STATE_LABELS[row.state],
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

/**
 * The Team page's opening view: everyone in the company, what each one is
 * doing right now, and the controls to do something about it.
 *
 * Cards and table are two drawings of one list, not two features. They share
 * the rows, the filters, the search and the controls, so switching between
 * them changes the density and nothing else.
 */
export function TeamCurrentWork({ companyId }: { companyId: string }) {
  const [filter, setFilter] = useState<TeamFilter>({ kind: "all" });
  const [search, setSearch] = useState("");
  const [view, setView] = useState<TeamView>(readStoredView);

  useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem(VIEW_STORAGE_KEY, view);
  }, [view]);

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
  const actions = useTeamMemberActions(companyId);

  // The clock only ticks while something is actually running, so a company
  // whose team is asleep does no work in the background.
  const anyRunning = rows.some((row) => row.runStartedAt !== null);
  const nowMs = useNowTick(anyRunning, CLOCK_TICK_MS);

  const needle = search.trim().toLowerCase();
  const visible = useMemo(
    () =>
      rows.filter((row) => {
        if (!matchesSearch(row, needle)) return false;
        if (filter.kind === "state") return row.state === filter.state;
        if (filter.kind === "group") return teamSummaryGroupMatches(filter.group, row.state);
        return true;
      }),
    [rows, needle, filter],
  );

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

  const activeGroup: TeamSummaryGroup = filter.kind === "group" ? filter.group : "all";

  return (
    <div className="space-y-4">
      <TeamSummaryTiles
        rows={rows}
        active={activeGroup}
        onPick={(group) => setFilter(group === "all" ? { kind: "all" } : { kind: "group", group })}
      />

      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-1.5" data-testid="team-state-filters">
          <FilterChip
            label="Everyone"
            count={rows.length}
            active={filter.kind === "all"}
            onClick={() => setFilter({ kind: "all" })}
          />
          {FILTER_ORDER.filter((state) => counts[state] > 0).map((state) => (
            <FilterChip
              key={state}
              label={TEAM_WORK_STATE_LABELS[state]}
              title={TEAM_WORK_STATE_DESCRIPTIONS[state]}
              count={counts[state]}
              active={filter.kind === "state" && filter.state === state}
              onClick={() =>
                setFilter((current) =>
                  current.kind === "state" && current.state === state
                    ? { kind: "all" }
                    : { kind: "state", state },
                )
              }
            />
          ))}
        </div>

        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1 lg:w-64 lg:flex-none">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search team or their work"
              aria-label="Search team or their work"
              className="h-8 w-full rounded-md border border-border bg-background pl-8 pr-7 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring"
            />
            {search && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setSearch("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <ViewToggle view={view} onChange={setView} />
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {needle
            ? "Nobody on the team matches that search."
            : "No agent is in that state right now."}
        </p>
      ) : view === "cards" ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {visible.map((row) => (
            <TeamMemberCard key={row.agent.id} row={row} actions={actions} nowMs={nowMs} />
          ))}
        </div>
      ) : (
        <TeamMemberTable rows={visible} actions={actions} nowMs={nowMs} />
      )}
    </div>
  );
}

function ViewToggle({
  view,
  onChange,
}: {
  view: TeamView;
  onChange: (view: TeamView) => void;
}) {
  return (
    <div className="flex shrink-0 items-center rounded-md border border-border p-0.5" role="group">
      <ViewToggleButton
        active={view === "cards"}
        label="Cards"
        onClick={() => onChange("cards")}
        icon={<LayoutGrid className="h-3.5 w-3.5" />}
      />
      <ViewToggleButton
        active={view === "table"}
        label="Table"
        onClick={() => onChange("table")}
        icon={<Rows3 className="h-3.5 w-3.5" />}
      />
    </div>
  );
}

function ViewToggleButton({
  active,
  label,
  icon,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      title={`${label} view`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
        active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
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
        "flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs transition-colors",
        active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50",
      )}
    >
      {label}
      <span className="text-[10px] tabular-nums opacity-70">{count}</span>
    </button>
  );
}
