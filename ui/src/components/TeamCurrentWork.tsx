import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, LayoutGrid, Network, Rows3, Search, X } from "lucide-react";
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
import {
  branchMemberIds,
  buildAttentionList,
  buildTeamHierarchy,
  groupRowsByBranch,
  orgContextFor,
  type TeamOrgContext,
} from "../lib/team-hierarchy";
import { EmptyState } from "./EmptyState";
import { PageSkeleton } from "./PageSkeleton";
import { TeamGroupedView } from "./TeamGroupedView";
import { TeamMemberCard } from "./TeamMemberCard";
import { TeamMemberTable } from "./TeamMemberTable";
import { TeamNeedsAttention } from "./TeamNeedsAttention";
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

type TeamView = "grouped" | "cards" | "table";

const TEAM_VIEWS: readonly TeamView[] = ["grouped", "cards", "table"];

/**
 * One state filter, not two. The summary tiles pick a group of states and
 * the chips pick a single state, but only one of them can be on at a time,
 * because a page that quietly held both would show a list neither control
 * explained.
 *
 * The organization filter below is deliberately NOT part of this, because it
 * is a different question. This one asks what somebody is doing; that one
 * asks which part of the company they are in. Answering both at once
 * ("everyone under the CTO who needs me") is the most useful thing on the
 * page for a company past a handful of people, so the two are kept
 * independent and each has its own way to clear it.
 */
type TeamFilter =
  | { kind: "all" }
  | { kind: "group"; group: TeamSummaryGroup }
  | { kind: "state"; state: TeamWorkState };

function readStoredView(): TeamView | null {
  if (typeof window === "undefined") return null;
  const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
  return TEAM_VIEWS.includes(stored as TeamView) ? (stored as TeamView) : null;
}

/** Free-text search across the things a person would actually type. */
function matchesSearch(
  row: TeamAgentWork,
  needle: string,
  org: TeamOrgContext | undefined,
): boolean {
  if (!needle) return true;
  const haystack = [
    row.agent.name,
    row.agent.title ?? "",
    // Their manager and their branch, so typing an executive's name finds
    // their people as well as the executive.
    org?.manager?.name ?? "",
    org?.branch?.name ?? "",
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
 * The three views are three drawings of one list, not three features. They
 * share the rows, the filters, the search and the controls, so switching
 * between them changes the shape and nothing else. By organization keeps the
 * company's reporting lines on screen; cards and table lay everyone out
 * side by side when that is what you want.
 */
export function TeamCurrentWork({ companyId }: { companyId: string }) {
  const [filter, setFilter] = useState<TeamFilter>({ kind: "all" });
  const [search, setSearch] = useState("");
  const [chosenView, setChosenView] = useState<TeamView | null>(readStoredView);
  /**
   * Which part of the company to show: an agent id meaning "this person and
   * everybody beneath them", or null for the whole company. Held separately
   * from the state filter for the reason written on TeamFilter above.
   */
  const [scopeId, setScopeId] = useState<string | null>(null);

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

  // Who works for whom, from the same reportsTo links the org chart draws.
  // Built here once and handed down, so the cards, the table, the sections
  // and the attention list can never disagree about the reporting lines.
  const hierarchy = useMemo(() => buildTeamHierarchy(agents ?? []), [agents]);
  const rowsById = useMemo(
    () => new Map(rows.map((row) => [row.agent.id, row])),
    [rows],
  );
  const orgById = useMemo(() => {
    const map = new Map<string, TeamOrgContext>();
    for (const row of rows) {
      map.set(row.agent.id, orgContextFor(hierarchy, row.agent.id, rowsById));
    }
    return map;
  }, [rows, hierarchy, rowsById]);

  const attention = useMemo(() => buildAttentionList(hierarchy, rows), [hierarchy, rows]);

  // A company with one executive branch and nobody below them reads better
  // as a plain grid: the sections would be headings over one card each. The
  // grouped view becomes the default only once there is a real shape to
  // show, and a view picked by hand always wins.
  const hierarchyWorthGrouping =
    hierarchy.topId !== null &&
    (hierarchy.branches.length > 1 ||
      [...hierarchy.byId.values()].some((node) => node.depth > 1));
  const view: TeamView = chosenView ?? (hierarchyWorthGrouping ? "grouped" : "cards");
  const setView = (next: TeamView) => {
    setChosenView(next);
    if (typeof window !== "undefined") window.localStorage.setItem(VIEW_STORAGE_KEY, next);
  };

  const scopeAgent = scopeId ? hierarchy.byId.get(scopeId)?.agent ?? null : null;
  const scopeIds = useMemo(
    () => (scopeId ? new Set(branchMemberIds(hierarchy, scopeId)) : null),
    [hierarchy, scopeId],
  );

  // A member who is filtered out of the list should not leave a stale scope
  // behind, and neither should switching company.
  useEffect(() => {
    if (scopeId && !hierarchy.byId.has(scopeId)) setScopeId(null);
  }, [hierarchy, scopeId]);

  // The clock only ticks while something is actually running, so a company
  // whose team is asleep does no work in the background.
  const anyRunning = rows.some((row) => row.runStartedAt !== null);
  const nowMs = useNowTick(anyRunning, CLOCK_TICK_MS);

  const needle = search.trim().toLowerCase();
  const visible = useMemo(
    () =>
      rows.filter((row) => {
        if (scopeIds && !scopeIds.has(row.agent.id)) return false;
        if (!matchesSearch(row, needle, orgById.get(row.agent.id))) return false;
        if (filter.kind === "state") return row.state === filter.state;
        if (filter.kind === "group") return teamSummaryGroupMatches(filter.group, row.state);
        return true;
      }),
    [rows, needle, filter, scopeIds, orgById],
  );

  const sections = useMemo(
    () => groupRowsByBranch(hierarchy, visible, rowsById),
    [hierarchy, visible, rowsById],
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

      {/*
        Company-wide on purpose, and not narrowed by the filters below it.
        The point of it is that a problem three levels down in one department
        reaches the front page without anybody going looking for it, and a
        panel that quietly hid problems outside the current filter would
        undo exactly that.
      */}
      <TeamNeedsAttention
        items={attention}
        actions={actions}
        onShowMember={(agentId) => {
          setScopeId(agentId);
          setFilter({ kind: "all" });
        }}
      />

      <TeamOrgFilterBar
        hierarchy={hierarchy}
        rowsById={rowsById}
        scopeId={scopeId}
        scopeName={scopeAgent?.name ?? null}
        onPick={setScopeId}
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
            : scopeAgent
              ? `Nobody in ${scopeAgent.name}'s organization is in that state right now.`
              : "No agent is in that state right now."}
        </p>
      ) : view === "grouped" ? (
        <TeamGroupedView
          sections={sections}
          actions={actions}
          nowMs={nowMs}
          orgById={orgById}
          onShowOrg={setScopeId}
        />
      ) : view === "cards" ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {visible.map((row) => (
            <TeamMemberCard
              key={row.agent.id}
              row={row}
              actions={actions}
              nowMs={nowMs}
              org={orgById.get(row.agent.id)}
              onShowOrg={() => setScopeId(row.agent.id)}
            />
          ))}
        </div>
      ) : (
        <TeamMemberTable
          rows={visible}
          actions={actions}
          nowMs={nowMs}
          orgById={orgById}
          onShowOrg={setScopeId}
        />
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
        active={view === "grouped"}
        label="By organization"
        onClick={() => onChange("grouped")}
        icon={<Network className="h-3.5 w-3.5" />}
      />
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

/**
 * Narrow the page to one part of the company.
 *
 * One chip per executive organization, plus whoever is currently in scope if
 * they are a manager further down (reached by clicking a manager's card).
 * "Reports under the CTO" is the filter the brief singles out as the most
 * useful one, and it means the whole organization beneath that person, not
 * only their direct reports.
 *
 * The bar hides itself for a company with no reporting lines to speak of,
 * because a single chip saying "everyone" is not a filter.
 */
function TeamOrgFilterBar({
  hierarchy,
  rowsById,
  scopeId,
  scopeName,
  onPick,
}: {
  hierarchy: ReturnType<typeof buildTeamHierarchy>;
  rowsById: Map<string, TeamAgentWork>;
  scopeId: string | null;
  scopeName: string | null;
  onPick: (agentId: string | null) => void;
}) {
  const branches = hierarchy.branches;
  const scopeIsBranch = scopeId !== null && branches.some((branch) => branch.id === scopeId);
  // Nothing to filter by in a company whose reporting lines have never been
  // set: every agent would get a chip, and picking one would say something
  // about the organization that nobody configured.
  if (!hierarchy.hasReportingLines && !scopeId) return null;
  if (branches.length < 2 && !scopeId) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="team-org-filters">
      <span className="text-xs text-muted-foreground">Part of the company:</span>
      <button
        type="button"
        aria-pressed={scopeId === null}
        onClick={() => onPick(null)}
        className={cn(
          "rounded-md border border-border px-2 py-1 text-xs transition-colors",
          scopeId === null ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50",
        )}
      >
        Whole company
      </button>

      {branches.map((branch) => {
        const size = branch.memberIds.filter((id) => rowsById.has(id)).length;
        const needsYou = branch.memberIds.filter((id) => rowsById.get(id)?.needsAttention).length;
        const active = scopeId === branch.id;
        return (
          <button
            key={branch.id}
            type="button"
            aria-pressed={active}
            title={`Show ${branch.leader.name} and everybody who reports up to them`}
            onClick={() => onPick(active ? null : branch.id)}
            className={cn(
              "flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs transition-colors",
              active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50",
            )}
          >
            {branch.leader.name}
            <span className="text-[10px] tabular-nums opacity-70">{size}</span>
            {needsYou > 0 && (
              <span className="text-[10px] font-medium tabular-nums text-destructive">
                {needsYou} !
              </span>
            )}
          </button>
        );
      })}

      {/*
        A manager below executive level does not get a permanent chip, or the
        bar would grow with the company. Clicking their card puts them in
        scope, and this chip is how you see that and how you get out of it.
      */}
      {scopeId && !scopeIsBranch && scopeName && (
        <button
          type="button"
          aria-pressed
          onClick={() => onPick(null)}
          className="flex items-center gap-1.5 rounded-md border border-border bg-accent px-2 py-1 text-xs text-foreground"
        >
          Under {scopeName}
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
