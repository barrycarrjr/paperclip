import { memo, useMemo } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import type { Agent, Issue } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import type { TranscriptEntry } from "../adapters";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import { ExternalLink, Moon } from "lucide-react";
import { formatNextWake, nextWakeAtMs } from "../lib/next-wake";
import { useNowTick } from "../hooks/useNowTick";
import { Identity } from "./Identity";
import { RunChatSurface } from "./RunChatSurface";
import { useLiveRunTranscripts } from "./transcript/useLiveRunTranscripts";
import { GroupedRunsCard, groupRunsByIssue } from "./GroupedRunsCard";
import { runNowLine, RUN_NOW_LINE_TONE_CLASSES } from "../lib/run-now-line";

const MIN_DASHBOARD_RUNS = 4;
const DASHBOARD_RUN_CARD_LIMIT = 4;
const DASHBOARD_LOG_POLL_INTERVAL_MS = 15_000;
const DASHBOARD_LOG_READ_LIMIT_BYTES = 64_000;
const DASHBOARD_MAX_CHUNKS_PER_RUN = 40;
const EMPTY_TRANSCRIPT: TranscriptEntry[] = [];

export const DASHBOARD_AGENT_RUN_CONFIG = {
  minRuns: MIN_DASHBOARD_RUNS,
  logPollIntervalMs: DASHBOARD_LOG_POLL_INTERVAL_MS,
  logReadLimitBytes: DASHBOARD_LOG_READ_LIMIT_BYTES,
  maxChunksPerRun: DASHBOARD_MAX_CHUNKS_PER_RUN,
} as const;

export function isRunActive(run: LiveRunForIssue): boolean {
  return run.status === "queued" || run.status === "running";
}

interface ActiveAgentsPanelProps {
  companyId: string;
  title?: string;
  minRunCount?: number;
  fetchLimit?: number;
  cardLimit?: number;
  gridClassName?: string;
  cardClassName?: string;
  emptyMessage?: string;
  queryScope?: string;
  showMoreLink?: boolean;
  /** Show the "asleep until" strip for scheduled agents with no active run. */
  showSleepingAgents?: boolean;
}

export function ActiveAgentsPanel({
  companyId,
  title = "Agents",
  minRunCount = MIN_DASHBOARD_RUNS,
  fetchLimit,
  cardLimit = DASHBOARD_RUN_CARD_LIMIT,
  gridClassName,
  cardClassName,
  emptyMessage = "No recent agent runs.",
  queryScope = "dashboard",
  showMoreLink = true,
  showSleepingAgents = true,
}: ActiveAgentsPanelProps) {
  const { data: liveRuns } = useQuery({
    queryKey: [...queryKeys.liveRuns(companyId), queryScope, { minRunCount, fetchLimit }],
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId, { minCount: minRunCount, limit: fetchLimit }),
  });

  const runs = liveRuns ?? [];
  const visibleRuns = useMemo(() => runs.slice(0, cardLimit), [cardLimit, runs]);
  const hiddenRunCount = Math.max(0, runs.length - visibleRuns.length);
  const { data: issues } = useQuery({
    queryKey: [...queryKeys.issues.list(companyId), "with-routine-executions"],
    queryFn: () => issuesApi.list(companyId, { includeRoutineExecutions: true }),
    enabled: visibleRuns.length > 0,
  });

  const issueById = useMemo(() => {
    const map = new Map<string, Issue>();
    for (const issue of issues ?? []) {
      map.set(issue.id, issue);
    }
    return map;
  }, [issues]);

  const { transcriptByRun, hasOutputForRun } = useLiveRunTranscripts({
    runs: visibleRuns,
    companyId,
    maxChunksPerRun: DASHBOARD_MAX_CHUNKS_PER_RUN,
    logPollIntervalMs: DASHBOARD_LOG_POLL_INTERVAL_MS,
    logReadLimitBytes: DASHBOARD_LOG_READ_LIMIT_BYTES,
    enableRealtimeUpdates: false,
  });

  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {runs.length === 0 ? (
        <div className="rounded-xl border border-border p-4">
          <p className="text-sm text-muted-foreground">{emptyMessage}</p>
        </div>
      ) : (
        <div className={cn("grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4", gridClassName)}>
          {groupRunsByIssue(visibleRuns).map((entry) =>
            entry.kind === "group" ? (
              <GroupedRunsCard
                key={`group-${entry.issueId}`}
                issue={issueById.get(entry.issueId)}
                runs={entry.runs}
                className={cardClassName}
              />
            ) : (
              <AgentRunCard
                key={entry.run.id}
                companyId={companyId}
                run={entry.run}
                issue={entry.run.issueId ? issueById.get(entry.run.issueId) : undefined}
                transcript={transcriptByRun.get(entry.run.id) ?? EMPTY_TRANSCRIPT}
                hasOutput={hasOutputForRun(entry.run.id)}
                isActive={isRunActive(entry.run)}
                className={cardClassName}
              />
            ),
          )}
        </div>
      )}
      {showMoreLink && hiddenRunCount > 0 && (
        <div className="mt-3 flex justify-end text-xs text-muted-foreground">
          <Link to="/dashboard/live" className="hover:text-foreground hover:underline">
            {hiddenRunCount} more active/recent run{hiddenRunCount === 1 ? "" : "s"}
          </Link>
        </div>
      )}
      {showSleepingAgents && (
        <SleepingAgentsStrip companyId={companyId} runs={runs} />
      )}
    </div>
  );
}

/**
 * Scheduled agents with no active run, each with its next wake time. Ends
 * the "is it ever going to run?" guesswork for quiet agents. Data comes from
 * the schedule fields the agents endpoint now appends.
 */
export function SleepingAgentsStrip({
  companyId,
  runs,
  agents: agentsProp,
}: {
  companyId: string;
  runs: LiveRunForIssue[];
  /** Pre-fetched agents (portfolio pages); omit to fetch for the company. */
  agents?: Agent[];
}) {
  const { data: fetchedAgents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: agentsProp == null,
  });
  const agents = agentsProp ?? fetchedAgents ?? [];
  // scheduled_retry counts as busy here: an agent with a pending retry gets
  // its "Will retry <time>" card, and a second "wakes in Xm" strip entry
  // would contradict it.
  const busyAgentIds = useMemo(
    () =>
      new Set(
        runs
          .filter((r) => isRunActive(r) || r.status === "scheduled_retry")
          .map((r) => r.agentId),
      ),
    [runs],
  );
  const now = useNowTick(true, 30_000);
  const sleeping = useMemo(
    () =>
      agents
        .map((agent) => ({ agent, wakeAt: nextWakeAtMs(agent) }))
        .filter(
          (entry): entry is { agent: Agent; wakeAt: number } =>
            entry.wakeAt != null && !busyAgentIds.has(entry.agent.id),
        )
        .sort((a, b) => a.wakeAt - b.wakeAt),
    [agents, busyAgentIds],
  );
  if (sleeping.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        <Moon className="h-3 w-3" /> Asleep:
      </span>
      {sleeping.map(({ agent, wakeAt }) => (
        <Link
          key={agent.id}
          to={`/agents/${agent.id}`}
          className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
          title={`${agent.name} runs on a schedule and last reported ${
            agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt) : "never"
          }.`}
        >
          <span className="font-medium">{agent.name}</span>
          <span className="tabular-nums">· {formatNextWake(wakeAt, now)}</span>
        </Link>
      ))}
    </div>
  );
}

export const AgentRunCard = memo(function AgentRunCard({
  companyId,
  run,
  issue,
  transcript,
  hasOutput,
  isActive,
  className,
}: {
  companyId: string;
  run: LiveRunForIssue;
  issue?: Issue;
  transcript: TranscriptEntry[];
  hasOutput: boolean;
  isActive: boolean;
  className?: string;
}) {
  return (
    <div className={cn(
      "flex h-[320px] flex-col overflow-hidden rounded-xl border shadow-sm",
      isActive
        ? "border-cyan-500/25 bg-cyan-500/[0.04] shadow-[0_16px_40px_rgba(6,182,212,0.08)]"
        : "border-border bg-background/70",
      className,
    )}>
      <div className="border-b border-border/60 px-3 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {isActive ? (
                <span className="relative flex h-2.5 w-2.5 shrink-0">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-70" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-cyan-500" />
                </span>
              ) : (
                <span className="inline-flex h-2.5 w-2.5 rounded-full bg-muted-foreground/35" />
              )}
              <Identity name={run.agentName} size="sm" className="[&>span:last-child]:!text-[11px]" />
            </div>
            <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
              <span>
                {isActive
                  ? "Live now"
                  : run.status === "scheduled_retry"
                    ? "Will retry"
                    : run.finishedAt
                      ? `Finished ${relativeTime(run.finishedAt)}`
                      : `Started ${relativeTime(run.createdAt)}`}
              </span>
            </div>
            <RunNowLineText run={run} />
          </div>

          <Link
            to={`/agents/${run.agentId}/runs/${run.id}`}
            className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <ExternalLink className="h-2.5 w-2.5" />
          </Link>
        </div>

        {run.issueId && (
          <div className="mt-3 rounded-lg border border-border/60 bg-background/60 px-2.5 py-2 text-xs">
            <Link
              to={`/issues/${issue?.identifier ?? run.issueId}`}
              className={cn(
                "line-clamp-2 hover:underline",
                isActive ? "text-cyan-700 dark:text-cyan-300" : "text-muted-foreground hover:text-foreground",
              )}
              title={issue?.title ? `${issue?.identifier ?? run.issueId.slice(0, 8)} - ${issue.title}` : issue?.identifier ?? run.issueId.slice(0, 8)}
            >
              {issue?.identifier ?? run.issueId.slice(0, 8)}
              {issue?.title ? ` - ${issue.title}` : ""}
            </Link>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <RunChatSurface
          run={run}
          transcript={transcript}
          hasOutput={hasOutput}
          companyId={companyId}
        />
      </div>
    </div>
  );
});

/** One-line "what is happening right now" under the card's status line. */
function RunNowLineText({ run }: { run: LiveRunForIssue }) {
  const line = runNowLine(run);
  if (!line) return null;
  return (
    <div
      className={cn("mt-1 truncate text-[11px]", RUN_NOW_LINE_TONE_CLASSES[line.tone])}
      title={line.title}
    >
      {line.text}
    </div>
  );
}
