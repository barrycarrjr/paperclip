import type { Agent, HeartbeatRun, Issue } from "@paperclipai/shared";

/**
 * The Team activity timeline: what the whole team has been doing over a
 * stretch of time, one row per member.
 *
 * The one thing to be clear about before reading any of this. A bar on this
 * timeline is a RUN, not a mood. The app records when each run started and
 * finished, so a bar is a fact. It does not record a history of an agent's
 * status, so the app cannot honestly say whether a gap between two bars was
 * an agent sitting idle, an agent that was paused at the time, or an agent
 * nobody had given any work to. A gap therefore means one thing only, and it
 * is labelled as that one thing: nothing was running.
 *
 * The single exception is a member that is paused RIGHT NOW, because the
 * agent record carries the moment it was paused. That is drawn as a band
 * from then to the right-hand edge, and only then.
 */

export type TeamTimelineRangeId = "1h" | "2h" | "today" | "24h";

export interface TeamTimelineRange {
  id: TeamTimelineRangeId;
  label: string;
  /** Where the left edge sits, given the moment the right edge is at. */
  startOf: (nowMs: number) => number;
}

export const TEAM_TIMELINE_RANGES: TeamTimelineRange[] = [
  { id: "1h", label: "Last hour", startOf: (now) => now - 60 * 60_000 },
  { id: "2h", label: "Last 2 hours", startOf: (now) => now - 2 * 60 * 60_000 },
  {
    id: "today",
    label: "Today",
    // Local midnight, not 24 hours back: "today" is a thing a person means
    // by the clock on the wall, not a rolling window.
    startOf: (now) => {
      const date = new Date(now);
      date.setHours(0, 0, 0, 0);
      return date.getTime();
    },
  },
  { id: "24h", label: "Last 24 hours", startOf: (now) => now - 24 * 60 * 60_000 },
];

export const TEAM_TIMELINE_DEFAULT_RANGE: TeamTimelineRangeId = "2h";

export function teamTimelineRange(id: TeamTimelineRangeId): TeamTimelineRange {
  return TEAM_TIMELINE_RANGES.find((range) => range.id === id) ?? TEAM_TIMELINE_RANGES[1]!;
}

/** How a bar is coloured, by what became of the run. */
export type TeamTimelineTone = "running" | "succeeded" | "failed" | "stopped" | "waiting";

export const TEAM_TIMELINE_TONE_LABELS: Record<TeamTimelineTone, string> = {
  running: "Running",
  succeeded: "Finished",
  failed: "Failed",
  stopped: "Stopped",
  waiting: "Waiting to start",
};

function toneForStatus(status: string): TeamTimelineTone {
  switch (status) {
    case "running":
      return "running";
    case "succeeded":
      return "succeeded";
    case "failed":
    case "timed_out":
      return "failed";
    case "cancelled":
      return "stopped";
    default:
      return "waiting";
  }
}

/** Why the run happened, in words rather than a database value. */
const INVOCATION_LABELS: Record<string, string> = {
  timer: "On its schedule",
  assignment: "Given a task",
  on_demand: "Started by hand",
  automation: "Started by an automation",
};

export interface TeamTimelineBlock {
  runId: string;
  /** Clipped to the window, so a bar never draws outside the chart. */
  startMs: number;
  endMs: number;
  /** True when the run began before the left edge. */
  startsBeforeWindow: boolean;
  /** True when the run has not finished, so the bar runs to the right edge. */
  ongoing: boolean;
  status: string;
  tone: TeamTimelineTone;
  /** The short name written inside the bar when there is room. */
  label: string;
  /** The full sentence for the tooltip. */
  title: string;
  taskIdentifier: string | null;
  taskHref: string | null;
  runHref: string;
}

export interface TeamTimelineRow {
  agent: Agent;
  blocks: TeamTimelineBlock[];
  /** How much of the window this member spent running, in milliseconds. */
  busyMs: number;
  /**
   * When this member was paused, for the band drawn to the right edge. Null
   * unless the member is paused right now and the app recorded the moment.
   */
  pausedFromMs: number | null;
}

export interface TeamTimelineInput {
  agents: Agent[];
  runs: HeartbeatRun[];
  issues: Issue[];
  fromMs: number;
  toMs: number;
}

function msOf(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function runIssueId(run: HeartbeatRun): string | null {
  const snapshot = run.contextSnapshot as { issueId?: unknown } | null;
  const value = snapshot?.issueId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function agentRef(agent: Agent): string {
  return agent.urlKey ?? agent.id;
}

/**
 * Turn the company's recent runs into one row per team member, with the bars
 * clipped to the window being looked at.
 */
export function buildTeamTimeline(input: TeamTimelineInput): TeamTimelineRow[] {
  const { fromMs, toMs } = input;
  const issueById = new Map<string, Issue>();
  for (const issue of input.issues) issueById.set(issue.id, issue);

  const blocksByAgent = new Map<string, TeamTimelineBlock[]>();

  for (const run of input.runs) {
    // A run that never started still has a created time, and a queued run
    // waiting for a slot is a real thing to see on the chart.
    const started = msOf(run.startedAt) ?? msOf(run.createdAt);
    if (started === null) continue;
    const finishedRaw = msOf(run.finishedAt);
    const ongoing = finishedRaw === null && (run.status === "running" || run.status === "queued");
    const finished = finishedRaw ?? (ongoing ? toMs : started);

    // Anything wholly outside the window is not this window's business.
    if (finished < fromMs || started > toMs) continue;

    const issueId = runIssueId(run);
    const issue = issueId ? issueById.get(issueId) : undefined;
    const identifier = issue?.identifier ?? null;
    const trigger = INVOCATION_LABELS[run.invocationSource] ?? run.invocationSource;
    const tone = toneForStatus(run.status);

    const label = issue ? (identifier ?? issue.title) : trigger;
    const titleParts = [
      TEAM_TIMELINE_TONE_LABELS[tone],
      issue ? `on ${identifier ? `${identifier} ` : ""}${issue.title}` : trigger.toLowerCase(),
    ];
    if (run.error) titleParts.push(`- ${run.error}`);

    const block: TeamTimelineBlock = {
      runId: run.id,
      startMs: Math.max(started, fromMs),
      endMs: Math.min(finished, toMs),
      startsBeforeWindow: started < fromMs,
      ongoing,
      status: run.status,
      tone,
      label,
      title: titleParts.join(" "),
      taskIdentifier: identifier,
      taskHref: issue ? `/issues/${identifier ?? issue.id}` : null,
      runHref: "",
    };

    const list = blocksByAgent.get(run.agentId);
    if (list) list.push(block);
    else blocksByAgent.set(run.agentId, [block]);
  }

  const rows: TeamTimelineRow[] = [];

  for (const agent of input.agents) {
    if (agent.status === "terminated") continue;
    const blocks = (blocksByAgent.get(agent.id) ?? []).sort((a, b) => a.startMs - b.startMs);
    for (const block of blocks) {
      block.runHref = `/agents/${agentRef(agent)}/runs/${block.runId}`;
    }

    // Overlapping bars are possible (a retry can start before the record of
    // the previous attempt closes), so busy time is measured by merging them
    // rather than by adding widths, which would report more than the window.
    let busyMs = 0;
    let mergedEnd = -Infinity;
    let mergedStart = -Infinity;
    for (const block of blocks) {
      if (block.startMs > mergedEnd) {
        if (mergedEnd > mergedStart) busyMs += mergedEnd - mergedStart;
        mergedStart = block.startMs;
        mergedEnd = block.endMs;
      } else if (block.endMs > mergedEnd) {
        mergedEnd = block.endMs;
      }
    }
    if (mergedEnd > mergedStart) busyMs += mergedEnd - mergedStart;

    const pausedAt = agent.status === "paused" ? msOf(agent.pausedAt) : null;
    const pausedFromMs =
      pausedAt !== null && pausedAt <= toMs ? Math.max(pausedAt, fromMs) : null;

    rows.push({ agent, blocks, busyMs, pausedFromMs });
  }

  // Busiest first: on a timeline the question is almost always "who has
  // actually been doing anything", and a screen of empty rows above the
  // working ones answers it slowly.
  return rows.sort((a, b) => {
    if (b.busyMs !== a.busyMs) return b.busyMs - a.busyMs;
    return a.agent.name.localeCompare(b.agent.name);
  });
}

/** Where a moment sits across the chart, as a percentage from the left. */
export function timelinePercent(ms: number, fromMs: number, toMs: number): number {
  const span = toMs - fromMs;
  if (span <= 0) return 0;
  return ((ms - fromMs) / span) * 100;
}

/**
 * The vertical gridlines and their clock labels. Aims for six or so, snapped
 * to a round number of minutes so the labels read like times a person would
 * say out loud.
 */
export function teamTimelineTicks(fromMs: number, toMs: number): number[] {
  const span = toMs - fromMs;
  if (span <= 0) return [];
  const stepCandidatesMin = [5, 10, 15, 30, 60, 120, 180, 360];
  const targetMin = span / 60_000 / 6;
  const stepMin =
    stepCandidatesMin.find((candidate) => candidate >= targetMin) ??
    stepCandidatesMin[stepCandidatesMin.length - 1]!;
  const stepMs = stepMin * 60_000;

  const ticks: number[] = [];
  const first = Math.ceil(fromMs / stepMs) * stepMs;
  for (let tick = first; tick <= toMs; tick += stepMs) ticks.push(tick);
  return ticks;
}

/** "1h 04m" / "12m" / "under a minute", for the busy-time column. */
export function formatBusyTime(ms: number): string {
  if (ms <= 0) return "nothing";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours}h ${String(rest).padStart(2, "0")}m` : `${hours}h`;
}
