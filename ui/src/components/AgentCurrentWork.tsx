import { useMemo } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import type { Agent, ActivityEvent, HeartbeatRun } from "@paperclipai/shared";
import { Activity, CheckCircle2, Clock, History, Radio, Wrench } from "lucide-react";
import { activityApi } from "../api/activity";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { accessApi } from "../api/access";
import { queryKeys } from "../lib/queryKeys";
import { buildCompanyUserProfileMap } from "../lib/company-members";
import { activityEntityName, activityEntityTitle } from "../lib/activity-entity-names";
import { agentActivityToShow } from "../lib/agent-activity-filter";
import { getAdapterLabel } from "../adapters/adapter-display-registry";
import { RUN_NOW_LINE_TONE_CLASSES, runNowLine } from "../lib/run-now-line";
import {
  buildTeamCurrentWork,
  TEAM_WORK_STATE_DESCRIPTIONS,
  TEAM_WORK_STATE_LABELS,
  type TeamAgentWork,
} from "../lib/team-current-work";
import {
  teamWorkStateBadge,
  teamWorkStateCardEdge,
  teamWorkStateDot,
  teamWorkStateDotDefault,
} from "../lib/status-colors";
import { AGENT_HEALTH_WINDOW_DAYS, formatSuccessRate, summarizeAgentHealth } from "../lib/agent-health";
import { formatElapsed } from "../lib/clippy-tool-labels";
import { cn, relativeTime } from "../lib/utils";
import { buildTeamHierarchy } from "../lib/team-hierarchy";
import { AgentOrgPanel } from "./AgentOrgPanel";
import { ActivityRow } from "./ActivityRow";
import { RunWorkProductsCard } from "./RunWorkProductsCard";
import { RunDocumentsCard } from "./RunDocumentsCard";
import { TeamMemberControls } from "./TeamMemberControls";
import { useTeamMemberActions } from "../hooks/useTeamMemberActions";
import { useNowTick } from "../hooks/useNowTick";

/** How many activity entries to show before sending you to the full page. */
const ACTIVITY_LIMIT = 20;

/**
 * How many to read. More than are shown, because the bookkeeping entries are
 * dropped afterwards and reading exactly twenty would often leave five.
 */
const ACTIVITY_FETCH_LIMIT = 80;

/** How many finished runs to list under recent outputs. */
const RECENT_OUTPUT_RUNS = 5;

const CLOCK_TICK_MS = 5_000;

/**
 * The top of one team member's own page: what it is doing right now, what it
 * has been doing, what it produced, what it can reach, and how it has been
 * getting on.
 *
 * This is the same reading of "what is it doing" the Team list uses, built
 * from the same function, so the sentence on the list and the sentence here
 * can never drift apart.
 *
 * Two things the mockup asks for are deliberately absent. There is no
 * progress bar, because nothing in the app knows how far through its work a
 * run is; elapsed time, last activity and the run's own quiet-warning are
 * shown instead, and those are measured rather than guessed. And there is no
 * "expected output", because an agent is not asked to declare one up front.
 * The closest real thing, what the agent said it would do next when its last
 * run ended, is shown under that name.
 */
export function AgentCurrentWork({
  agent,
  companyId,
  runs,
  agentRouteId,
  runtimeLastError,
}: {
  agent: Agent;
  companyId: string;
  /** The agent's own runs, already loaded by the page. */
  runs: HeartbeatRun[];
  agentRouteId: string;
  /**
   * The last error from the agent's runtime state, which this page already
   * loads. The roster carries the same fact, but the single-agent route does
   * not, so without this the page that owns the answer would be the one page
   * saying no reason was recorded.
   */
  runtimeLastError?: string | null;
}) {
  const nowMs = useNowTick(true, CLOCK_TICK_MS);

  const { data: liveRuns } = useQuery({
    queryKey: [...queryKeys.liveRuns(companyId), "agent-current-work"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId),
    refetchInterval: 15_000,
  });

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(companyId),
    queryFn: () => issuesApi.list(companyId),
  });

  const { data: pendingInteractions } = useQuery({
    queryKey: [...queryKeys.issues.list(companyId), "pending-interactions", 50],
    queryFn: () => issuesApi.listPendingInteractions(companyId, 50),
  });

  // Three places record why an agent stopped and any of them can be empty:
  // the roster's copy, the runtime row, and the failed run itself. The runs
  // are already loaded for this page, so the last one costs nothing to read
  // and is the one that actually had the message in practice.
  const lastFailedRunError = useMemo(() => {
    const failed = [...runs]
      .filter((run) => run.error && (run.status === "failed" || run.status === "timed_out"))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
    return failed?.error ?? null;
  }, [runs]);

  const row = useMemo<TeamAgentWork | null>(() => {
    const rows = buildTeamCurrentWork({
      agents: [
        {
          ...agent,
          lastError: agent.lastError ?? runtimeLastError ?? lastFailedRunError ?? null,
        },
      ],
      liveRuns: liveRuns ?? [],
      issues: issues ?? [],
      pendingInteractions: pendingInteractions ?? [],
      now: nowMs,
    });
    return rows[0] ?? null;
  }, [agent, runtimeLastError, lastFailedRunError, liveRuns, issues, pendingInteractions, nowMs]);

  // The rest of the company, for the panel that says where this member sits
  // and how their own organization is doing. Same query key as the Team
  // page, so on a normal walk from Team to a member it is already cached.
  const { data: companyAgents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });

  const hierarchy = useMemo(() => buildTeamHierarchy(companyAgents ?? []), [companyAgents]);

  // Deliberately not keyed on the ticking clock: these rows feed a list of
  // states and names, none of which change second to second, and rebuilding
  // every member's row on every tick would be real work for no difference on
  // screen.
  const companyRows = useMemo(
    () =>
      buildTeamCurrentWork({
        agents: companyAgents ?? [],
        liveRuns: liveRuns ?? [],
        issues: issues ?? [],
        pendingInteractions: pendingInteractions ?? [],
      }),
    [companyAgents, liveRuns, issues, pendingInteractions],
  );

  const health = useMemo(() => summarizeAgentHealth(runs, { now: nowMs }), [runs, nowMs]);

  const sortedRuns = useMemo(
    () =>
      [...runs].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    [runs],
  );

  const latestRun = sortedRuns[0] ?? null;
  const liveRunId = row?.runId ?? null;

  return (
    <div className="space-y-6">
      {row && (
        <CurrentTaskPanel
          row={row}
          companyId={companyId}
          nowMs={nowMs}
          latestRun={latestRun}
          agentRouteId={agentRouteId}
        />
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <AgentActivityStream agent={agent} companyId={companyId} />
          <RecentOutputs
            runs={sortedRuns}
            liveRunId={liveRunId}
            agentRouteId={agentRouteId}
          />
        </div>

        <div className="space-y-6">
          <AgentOrgPanel agent={agent} hierarchy={hierarchy} rows={companyRows} />
          <HealthPanel health={health} />
          <ToolsPanel agent={agent} companyId={companyId} />
        </div>
      </div>
    </div>
  );
}

function SectionHeading({
  icon: Icon,
  title,
  action,
}: {
  icon: typeof Activity;
  title: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h3 className="flex items-center gap-1.5 text-sm font-medium">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        {title}
      </h3>
      {action}
    </div>
  );
}

function CurrentTaskPanel({
  row,
  companyId,
  nowMs,
  latestRun,
  agentRouteId,
}: {
  row: TeamAgentWork;
  companyId: string;
  nowMs: number;
  latestRun: HeartbeatRun | null;
  agentRouteId: string;
}) {
  const actions = useTeamMemberActions(companyId);
  const startedMs = row.runStartedAt ? new Date(row.runStartedAt).getTime() : null;
  const taskHref = row.task ? `/issues/${row.task.identifier ?? row.task.issueId}` : null;

  // What the agent itself said it would do next. Only written when a run
  // ends, so it describes the plan from here rather than the work in flight.
  const nextAction =
    latestRun && !row.runId && typeof latestRun.nextAction === "string"
      ? latestRun.nextAction
      : null;

  return (
    <div
      className={cn(
        "rounded-xl border bg-card p-4",
        teamWorkStateCardEdge[row.state] ?? "border-border/70",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <span
              title={TEAM_WORK_STATE_DESCRIPTIONS[row.state]}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
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
            {row.runId && (
              <Link
                to={`/agents/${agentRouteId}/runs/${row.runId}`}
                className="text-xs text-muted-foreground hover:text-foreground hover:underline"
              >
                Open the live run
              </Link>
            )}
          </div>

          <p className="text-base font-medium">{row.line}</p>
          {row.detail && (
            <p
              className={cn(
                "text-sm",
                row.detailTone
                  ? RUN_NOW_LINE_TONE_CLASSES[row.detailTone]
                  : "text-muted-foreground",
              )}
            >
              {row.detail}
            </p>
          )}
        </div>

        <TeamMemberControls row={row} actions={actions} />
      </div>

      {taskHref && row.task && (
        <Link
          to={taskHref}
          className="mt-3 flex min-w-0 items-baseline gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm hover:bg-accent/50"
        >
          {row.task.identifier && (
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {row.task.identifier}
            </span>
          )}
          <span className="truncate">{row.task.title}</span>
        </Link>
      )}

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
        <Fact label="Running for">
          {startedMs !== null && Number.isFinite(startedMs)
            ? formatElapsed(nowMs - startedMs)
            : "Nothing running"}
        </Fact>
        <Fact label="Last did something">
          {row.lastActivityAt ? relativeTime(row.lastActivityAt) : "Nothing recorded"}
        </Fact>
        <Fact label="Runs on">{getAdapterLabel(row.agent.adapterType)}</Fact>
        <Fact label="Open tasks">
          {row.assignedOpenCount === 0 ? "None assigned" : String(row.assignedOpenCount)}
        </Fact>
      </dl>

      {nextAction && (
        <div className="mt-3 rounded-md border border-border/60 bg-muted/20 px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            What it said it would do next
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">{nextAction}</p>
        </div>
      )}

      {row.reviewWaiting.length > 0 && row.state !== "needs_review" && (
        <p className="mt-3 text-xs text-violet-600 dark:text-violet-400">
          {row.reviewWaiting.length === 1
            ? "1 finished task is also waiting on your review."
            : `${row.reviewWaiting.length} finished tasks are also waiting on your review.`}
        </p>
      )}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="truncate">{children}</dd>
    </div>
  );
}

/**
 * What this member has been doing, from the company's own activity record.
 *
 * This is the business-level record (took a task, commented, changed a
 * status, finished a run), not the model's reasoning. The raw transcript
 * lives one click deeper on the run's own page, which is where it belongs.
 */
function AgentActivityStream({ agent, companyId }: { agent: Agent; companyId: string }) {
  const { data: rawEvents, isLoading } = useQuery({
    queryKey: [...queryKeys.activity(companyId), { agentId: agent.id, limit: ACTIVITY_FETCH_LIMIT }],
    queryFn: () => activityApi.list(companyId, { agentId: agent.id, limit: ACTIVITY_FETCH_LIMIT }),
    refetchInterval: 30_000,
  });

  // Workspace leases are recorded twice per run and would otherwise be most
  // of this panel, pushing the things the agent actually did off the bottom.
  const events = useMemo(
    () => agentActivityToShow(rawEvents ?? [], ACTIVITY_LIMIT),
    [rawEvents],
  );

  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId),
    queryFn: () => accessApi.listUserDirectory(companyId),
  });

  const agentMap = useMemo(() => new Map([[agent.id, agent]]), [agent]);
  const userProfileMap = useMemo(
    () => buildCompanyUserProfileMap(companyMembers?.users),
    [companyMembers?.users],
  );

  const entityNameMap = useMemo(() => {
    const map = new Map<string, string>();
    map.set(`agent:${agent.id}`, agent.name);
    for (const event of events) {
      const name = activityEntityName(event as ActivityEvent);
      if (name) map.set(`${event.entityType}:${event.entityId}`, name);
    }
    return map;
  }, [events, agent]);

  const entityTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const event of events) {
      const title = activityEntityTitle(event as ActivityEvent);
      if (title) map.set(`${event.entityType}:${event.entityId}`, title);
    }
    return map;
  }, [events]);

  return (
    <div className="space-y-3">
      <SectionHeading
        icon={Activity}
        title="Live activity"
        action={
          <Link
            to={`/activity?agentId=${agent.id}`}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            See all &rarr;
          </Link>
        }
      />
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Reading the record...</p>
      ) : events.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing recorded for this team member yet.
        </p>
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border">
          {events.map((event) => (
            <ActivityRow
              key={event.id}
              event={event}
              agentMap={agentMap}
              userProfileMap={userProfileMap}
              entityNameMap={entityNameMap}
              entityTitleMap={entityTitleMap}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * What came out of the recent runs: the files and notes the latest run
 * produced, and before that a short list of how the last few runs ended.
 *
 * The verdict on each line is the app's own classification of the run, not a
 * summary written for the screen, so "Only planned, took no action" says
 * exactly that rather than being dressed up as progress.
 */
function RecentOutputs({
  runs,
  liveRunId,
  agentRouteId,
}: {
  runs: HeartbeatRun[];
  liveRunId: string | null;
  agentRouteId: string;
}) {
  const latest = runs[0] ?? null;
  const finished = runs
    .filter((run) => run.finishedAt !== null)
    .slice(0, RECENT_OUTPUT_RUNS);

  return (
    <div className="space-y-3">
      <SectionHeading
        icon={CheckCircle2}
        title="Recent outputs"
        action={
          <Link
            to={`/agents/${agentRouteId}/runs`}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            All runs &rarr;
          </Link>
        }
      />

      {latest && (
        <div className="space-y-3">
          <RunWorkProductsCard runId={latest.id} isLive={latest.id === liveRunId} />
          <RunDocumentsCard runId={latest.id} isLive={latest.id === liveRunId} />
        </div>
      )}

      {finished.length === 0 ? (
        <p className="text-sm text-muted-foreground">No run has finished yet.</p>
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border">
          {finished.map((run) => (
            <FinishedRunRow key={run.id} run={run} agentRouteId={agentRouteId} />
          ))}
        </div>
      )}
    </div>
  );
}

function FinishedRunRow({ run, agentRouteId }: { run: HeartbeatRun; agentRouteId: string }) {
  const verdict = runNowLine({
    status: run.status,
    livenessState: run.livenessState ?? null,
    livenessReason: run.livenessReason ?? null,
    outputSilence: undefined,
    retryOfRunId: run.retryOfRunId ?? null,
    scheduledRetryAt: null,
    scheduledRetryAttempt: 0,
    scheduledRetryReason: null,
  });

  const summary =
    typeof (run.resultJson as Record<string, unknown> | null)?.summary === "string"
      ? String((run.resultJson as Record<string, unknown>).summary)
      : null;

  return (
    <Link
      to={`/agents/${agentRouteId}/runs/${run.id}`}
      className="block px-3 py-2 text-sm hover:bg-accent/30"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span
          className={cn(
            "truncate text-xs font-medium",
            verdict ? RUN_NOW_LINE_TONE_CLASSES[verdict.tone] : "text-muted-foreground",
          )}
          title={verdict?.title}
        >
          {verdict?.text ?? run.status}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {relativeTime(run.finishedAt ?? run.createdAt)}
        </span>
      </div>
      {summary && (
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{summary}</p>
      )}
    </Link>
  );
}

function HealthPanel({ health }: { health: ReturnType<typeof summarizeAgentHealth> }) {
  const nothing = health.total === 0;

  return (
    <div className="space-y-3">
      <SectionHeading icon={History} title={`Last ${AGENT_HEALTH_WINDOW_DAYS} days`} />
      {nothing ? (
        <p className="text-sm text-muted-foreground">
          This team member has not run in the last {AGENT_HEALTH_WINDOW_DAYS} days.
        </p>
      ) : (
        <dl className="grid grid-cols-2 gap-3 rounded-lg border border-border p-3 text-xs">
          <Fact label="Runs">{health.total}</Fact>
          <Fact label="Got there">{formatSuccessRate(health.successRate)}</Fact>
          <Fact label="Typical run">
            {health.typicalDurationMs === null
              ? "Nothing finished"
              : formatElapsed(health.typicalDurationMs)}
          </Fact>
          <Fact label="Failed">{health.failed}</Fact>
          <Fact label="Last success">
            {health.lastSuccessAt ? relativeTime(health.lastSuccessAt) : "None yet"}
          </Fact>
          <Fact label="Last failure">
            {health.lastFailureAt ? relativeTime(health.lastFailureAt) : "None"}
          </Fact>
          {health.stopped > 0 && (
            <Fact label="Stopped by hand">{health.stopped}</Fact>
          )}
          {health.live > 0 && (
            <Fact label="Going now">
              <span className="inline-flex items-center gap-1">
                <Radio className="h-3 w-3 text-cyan-500" />
                {health.live}
              </span>
            </Fact>
          )}
        </dl>
      )}
      <p className="text-[11px] text-muted-foreground">
        A run somebody stopped by hand is counted on its own, not as a failure. "Typical
        run" is the middle run's length, so one very long wait does not move it.
      </p>
    </div>
  );
}

/**
 * What this member can actually reach.
 *
 * In this app that means its skills and the provider it runs on, which is
 * what the roster really stores. The mockup shows named integrations such as
 * GitHub or Slack; those are add-ons installed for a whole company rather
 * than granted to one agent, so listing them per member would say something
 * about access that is not true.
 */
function ToolsPanel({ agent, companyId }: { agent: Agent; companyId: string }) {
  const { data: skills, isLoading } = useQuery({
    queryKey: queryKeys.agents.skills(agent.id),
    queryFn: () => agentsApi.skills(agent.id, companyId),
  });

  const active = (skills?.entries ?? []).filter(
    (entry) => entry.desired || entry.state === "installed" || entry.state === "configured",
  );

  return (
    <div className="space-y-3">
      <SectionHeading icon={Wrench} title="Can use" />
      <div className="space-y-2 rounded-lg border border-border p-3">
        <div className="flex items-center gap-2 text-xs">
          <Clock className="h-3 w-3 text-muted-foreground" />
          <span className="text-muted-foreground">Runs on</span>
          <span className="font-medium">{getAdapterLabel(agent.adapterType)}</span>
        </div>
        {isLoading ? (
          <p className="text-xs text-muted-foreground">Reading its skills...</p>
        ) : skills && !skills.supported ? (
          <p className="text-xs text-muted-foreground">
            This provider does not carry skills, so there is nothing to list.
          </p>
        ) : active.length === 0 ? (
          <p className="text-xs text-muted-foreground">No skills are turned on for it.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {active.map((entry) => (
              <span
                key={entry.key}
                title={entry.detail ?? entry.originLabel ?? undefined}
                className="rounded border border-border/70 px-1.5 py-0.5 text-[11px]"
              >
                {entry.runtimeName ?? entry.key}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
