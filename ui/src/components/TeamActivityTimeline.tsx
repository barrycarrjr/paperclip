import { useMemo, useState } from "react";
import { Link, useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { Bot, RefreshCw } from "lucide-react";
import { agentsApi } from "../api/agents";
import { buildTeamHierarchy } from "../lib/team-hierarchy";
import { heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { agentUrl, cn } from "../lib/utils";
import {
  buildTeamTimeline,
  formatBusyTime,
  TEAM_TIMELINE_DEFAULT_RANGE,
  orderTimelineByOrganization,
  TEAM_TIMELINE_RANGES,
  TEAM_TIMELINE_TONE_LABELS,
  teamTimelineRange,
  teamTimelineTicks,
  timelinePercent,
  type TeamTimelineBlock,
  type TeamTimelineEntry,
  type TeamTimelineOrdering,
  type TeamTimelineRangeId,
  type TeamTimelineRow,
  type TeamTimelineTone,
} from "../lib/team-timeline";
import { Button } from "@/components/ui/button";
import { EmptyState } from "./EmptyState";
import { PageSkeleton } from "./PageSkeleton";
import { useNowTick } from "../hooks/useNowTick";

/**
 * A ceiling, not the shape of the request. The window itself is what bounds
 * the read (see `since` below); this only stops a pathological company from
 * returning an unbounded list.
 */
const RUN_FETCH_LIMIT = 1000;

/**
 * The left edge is rounded down to this before it is sent, so a clock that
 * ticks every thirty seconds does not produce a new request every thirty
 * seconds. The chart still draws against the real edge; only the query is
 * coarse.
 */
const SINCE_BUCKET_MS = 5 * 60_000;

/** The chart redraws on this cadence, which is also the "now" line's step. */
const TICK_MS = 30_000;

const REFRESH_MS = 30_000;

const TONE_BAR: Record<TeamTimelineTone, string> = {
  running: "bg-cyan-500/80 hover:bg-cyan-500",
  succeeded: "bg-emerald-500/70 hover:bg-emerald-500",
  failed: "bg-red-500/75 hover:bg-red-500",
  stopped: "bg-neutral-400/70 hover:bg-neutral-400",
  waiting: "bg-sky-400/60 hover:bg-sky-400",
};

const TONE_DOT: Record<TeamTimelineTone, string> = {
  running: "bg-cyan-500",
  succeeded: "bg-emerald-500",
  failed: "bg-red-500",
  stopped: "bg-neutral-400",
  waiting: "bg-sky-400",
};

function clockLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * One row per team member, and along each row the stretches of time that
 * member had a run going.
 *
 * What a gap means is written on the screen rather than left to be guessed,
 * because it is the one thing about this chart that can be read wrongly. The
 * app records runs, not a history of how each agent felt, so an empty
 * stretch says only that nothing was running.
 */
export function TeamActivityTimeline({ companyId }: { companyId: string }) {
  const [rangeId, setRangeId] = useState<TeamTimelineRangeId>(TEAM_TIMELINE_DEFAULT_RANGE);
  const nowMs = useNowTick(true, TICK_MS);

  const range = teamTimelineRange(rangeId);
  const fromMs = range.startOf(nowMs);
  const toMs = nowMs;
  const sinceIso = useMemo(
    () => new Date(Math.floor(fromMs / SINCE_BUCKET_MS) * SINCE_BUCKET_MS).toISOString(),
    [fromMs],
  );

  const {
    data: agents,
    isLoading: agentsLoading,
    error,
  } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });

  const {
    data: runs,
    isLoading: runsLoading,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: [...queryKeys.agents.list(companyId), "timeline-runs", sinceIso, RUN_FETCH_LIMIT],
    queryFn: () => heartbeatsApi.list(companyId, undefined, RUN_FETCH_LIMIT, sinceIso),
    refetchInterval: REFRESH_MS,
    // Keeps the previous window's bars on screen while a wider one loads,
    // instead of blanking the chart every time the range button is pressed.
    placeholderData: (previous) => previous,
  });

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(companyId),
    queryFn: () => issuesApi.list(companyId),
  });

  // Which order the rows are in: how busy everybody has been, or the shape
  // of the company. Busiest-first stays the default because the first
  // question a timeline is opened for is "has anything happened".
  const [ordering, setOrdering] = useState<TeamTimelineOrdering>("busy");

  const rows = useMemo(
    () =>
      buildTeamTimeline({
        agents: agents ?? [],
        runs: runs ?? [],
        issues: issues ?? [],
        fromMs,
        toMs,
      }),
    [agents, runs, issues, fromMs, toMs],
  );

  const ticks = useMemo(() => teamTimelineTicks(fromMs, toMs), [fromMs, toMs]);
  const anyActivity = rows.some((row) => row.blocks.length > 0);

  // The same reporting lines the rest of Team reads, so the headings here
  // and the sections on the right-now view can never disagree.
  const hierarchy = useMemo(() => buildTeamHierarchy(agents ?? []), [agents]);
  const entries = useMemo<TeamTimelineEntry[]>(
    () =>
      ordering === "org"
        ? orderTimelineByOrganization(rows, hierarchy)
        : rows.map((row) => ({ kind: "row", row, depth: 0, managerName: null })),
    [ordering, rows, hierarchy],
  );

  if (agentsLoading || runsLoading) return <PageSkeleton variant="list" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Bot}
        message="No agents in this company yet. Once there are, this is where you see what they have been doing."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {TEAM_TIMELINE_RANGES.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={option.id === rangeId}
              onClick={() => setRangeId(option.id)}
              className={cn(
                "rounded-md border border-border px-2 py-1 text-xs transition-colors",
                option.id === rangeId
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {/*
            Two orders, not two charts. The bars, the window and everything
            the chart claims are identical either way; only what is next to
            what changes.
          */}
          <span className="text-xs text-muted-foreground">Order:</span>
          {(
            [
              { id: "busy" as const, label: "Busiest first" },
              { id: "org" as const, label: "By organization" },
            ]
          ).map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={option.id === ordering}
              onClick={() => setOrdering(option.id)}
              title={
                option.id === "org"
                  ? "Group the rows by executive organization, indented by who reports to whom"
                  : "Put the members who have run the most at the top"
              }
              className={cn(
                "rounded-md border border-border px-2 py-1 text-xs transition-colors",
                option.id === ordering
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void refetch()}
          disabled={isFetching}
          title="Read the runs again now"
        >
          <RefreshCw className={cn(isFetching && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <div className="min-w-[48rem]">
          <div className="flex items-end border-b border-border bg-accent/20 px-3 py-1.5">
            <div className="w-52 shrink-0 text-xs font-medium text-muted-foreground">
              Team member
            </div>
            <div className="relative h-4 flex-1">
              {ticks.map((tick) => (
                <span
                  key={tick}
                  className="absolute -translate-x-1/2 text-[10px] tabular-nums text-muted-foreground"
                  style={{ left: `${timelinePercent(tick, fromMs, toMs)}%` }}
                >
                  {clockLabel(tick)}
                </span>
              ))}
            </div>
          </div>

          {entries.map((entry) =>
            entry.kind === "heading" ? (
              <p
                key={`heading-${entry.id}`}
                className="border-b border-border bg-accent/20 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
              >
                {entry.title}
              </p>
            ) : (
              <TimelineRow
                key={entry.row.agent.id}
                row={entry.row}
                depth={entry.depth}
                managerName={entry.managerName}
                fromMs={fromMs}
                toMs={toMs}
                ticks={ticks}
              />
            ),
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        {(Object.keys(TONE_DOT) as TeamTimelineTone[]).map((tone) => (
          <span key={tone} className="inline-flex items-center gap-1.5">
            <span className={cn("inline-block h-2 w-2 rounded-sm", TONE_DOT[tone])} />
            {TEAM_TIMELINE_TONE_LABELS[tone]}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-orange-400/50" />
          Paused
        </span>
      </div>

      <p className="text-xs text-muted-foreground">
        Each bar is a run. An empty stretch means nothing was running: the app records
        runs, not a history of each agent's status, so it cannot honestly tell you
        whether a quiet gap was an agent with no work or an agent that was paused at the
        time. The orange band on the right of a row is the one exception, because the
        moment a member was paused is recorded.
        {!anyActivity && " Nothing ran in this window at all."}
      </p>
    </div>
  );
}

function TimelineRow({
  row,
  depth,
  managerName,
  fromMs,
  toMs,
  ticks,
}: {
  row: TeamTimelineRow;
  /** How deep under the heading this member sits, for the indent. */
  depth?: number;
  /** Their manager, named in the tooltip when the rows are in company order. */
  managerName?: string | null;
  fromMs: number;
  toMs: number;
  ticks: number[];
}) {
  const navigate = useNavigate();

  return (
    <div className="flex items-center border-b border-border px-3 py-2 last:border-b-0 hover:bg-accent/10">
      <div
        className="w-52 shrink-0 pr-3"
        // Indented rather than nested, so every bar still starts at the same
        // place across the chart and the times stay comparable down the page.
        style={depth ? { paddingLeft: `${Math.min(depth, 4) * 12}px` } : undefined}
      >
        <Link
          to={agentUrl(row.agent)}
          title={managerName ? `Reports to ${managerName}` : undefined}
          className="block truncate text-sm font-medium hover:underline"
        >
          {row.agent.name}
        </Link>
        <span className="block text-[11px] text-muted-foreground">
          {row.blocks.length === 0
            ? "Nothing ran"
            : `${formatBusyTime(row.busyMs)} across ${row.blocks.length} ${row.blocks.length === 1 ? "run" : "runs"}`}
        </span>
      </div>

      <div className="relative h-8 flex-1 rounded bg-muted/40">
        {ticks.map((tick) => (
          <span
            key={tick}
            aria-hidden
            className="absolute inset-y-0 w-px bg-border/70"
            style={{ left: `${timelinePercent(tick, fromMs, toMs)}%` }}
          />
        ))}

        {row.pausedFromMs !== null && (
          <span
            aria-hidden
            title="Paused, from this point to now"
            className="absolute inset-y-0 rounded-sm bg-orange-400/25"
            style={{
              left: `${timelinePercent(row.pausedFromMs, fromMs, toMs)}%`,
              right: 0,
            }}
          />
        )}

        {row.blocks.map((block) => (
          <TimelineBar
            key={block.runId}
            block={block}
            fromMs={fromMs}
            toMs={toMs}
            onOpen={() => navigate(block.runHref)}
          />
        ))}
      </div>
    </div>
  );
}

function TimelineBar({
  block,
  fromMs,
  toMs,
  onOpen,
}: {
  block: TeamTimelineBlock;
  fromMs: number;
  toMs: number;
  onOpen: () => void;
}) {
  const left = timelinePercent(block.startMs, fromMs, toMs);
  const right = timelinePercent(block.endMs, fromMs, toMs);
  // A run of a few seconds still has to be clickable, so a bar has a floor
  // rather than collapsing to a hairline nobody can hit.
  const width = Math.max(right - left, 0.6);

  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${block.title} - ${clockLabel(block.startMs)} to ${block.ongoing ? "now" : clockLabel(block.endMs)}`}
      className={cn(
        "absolute inset-y-1 flex items-center overflow-hidden rounded-sm px-1.5 text-left text-[10px] font-medium text-white transition-colors",
        TONE_BAR[block.tone],
        block.startsBeforeWindow && "rounded-l-none",
        block.ongoing && "rounded-r-none",
      )}
      style={{ left: `${left}%`, width: `${width}%` }}
    >
      <span className="truncate">{block.label}</span>
    </button>
  );
}
