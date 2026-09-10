import type { Agent, Issue } from "@paperclipai/shared";
import type { LiveRunForIssue } from "../api/heartbeats";
import type { PendingCompanyInteraction } from "../api/issues";
import { formatNextWake, nextWakeAtMs } from "./next-wake";
import { runNowLine, type RunNowLine } from "./run-now-line";

/**
 * What one agent is doing right now, for the Team page.
 *
 * Every state below is read from something the app already stores: a live
 * run, a question the agent asked and is waiting on, work it finished and
 * handed back for review, the agent's own paused or error status, its
 * scheduler wake time, or the tasks assigned to it. Nothing here is guessed.
 *
 * Deliberately NOT modelled, because the app has no such field: how far
 * through its work a run is. There is no total to measure against, so a
 * percentage would be a made-up number. What the app really knows is how
 * long the run has been going, when it last did something, and whether it
 * has gone quiet, and those are reported instead.
 *
 * Also not modelled: an agent's objective, and who owns the next action on a
 * piece of work. Assigned work and the reporting line are the closest real
 * data.
 */
export type TeamWorkState =
  | "needs_you"
  | "needs_review"
  | "working"
  | "retrying"
  | "error"
  | "paused"
  | "waiting"
  | "quiet";

/** The task a row is about, when there is one to link to. */
export interface TeamWorkTask {
  issueId: string;
  identifier: string | null;
  title: string;
}

export interface TeamAgentWork {
  agent: Agent;
  state: TeamWorkState;
  /** The plain sentence shown under the agent's name. */
  line: string;
  /** A second, quieter sentence, or null when there is nothing to add. */
  detail: string | null;
  /**
   * How to colour the detail sentence, when it came from a run's own health
   * signal (going quiet, waiting on a limit reset). Null when the detail is
   * ordinary prose.
   */
  detailTone: RunNowLine["tone"] | null;
  task: TeamWorkTask | null;
  /** The run to link to, when one is live. */
  runId: string | null;
  /** When the live run started, so the page can show how long it has been going. */
  runStartedAt: string | null;
  /**
   * The last moment this agent is known to have done something: the run's
   * last useful action or last output while one is live, otherwise the last
   * time the scheduler heard from it. Null when nothing is recorded.
   */
  lastActivityAt: string | null;
  /** Open tasks assigned to this agent. */
  assignedOpenCount: number;
  /** Work this agent finished and handed back, waiting on a person to review. */
  reviewWaiting: TeamWorkTask[];
  /** True for the states a person has to do something about. */
  needsAttention: boolean;
}

/** Short label for the state pill. */
export const TEAM_WORK_STATE_LABELS: Record<TeamWorkState, string> = {
  needs_you: "Needs you",
  needs_review: "Ready for review",
  working: "Working",
  retrying: "Trying again",
  error: "Error",
  paused: "Paused",
  waiting: "Waiting",
  quiet: "Nothing running",
};

/** What each state means, in one sentence, for a tooltip. */
export const TEAM_WORK_STATE_DESCRIPTIONS: Record<TeamWorkState, string> = {
  needs_you: "This agent asked a question and cannot go further until you answer it.",
  needs_review: "This agent finished work and handed it back for you to look at.",
  working: "A run for this agent is going right now.",
  retrying: "A run stopped and the agent will start it again on its own.",
  error: "The agent is in an error state and will not pick work up until it is sorted out.",
  paused: "The agent is paused, so no new run will start.",
  waiting: "The agent is not running anything and is due to wake on its schedule.",
  quiet: "Nothing is running and no wake time is set.",
};

/** The states that are waiting on a person rather than on an agent. */
export const TEAM_ATTENTION_STATES: readonly TeamWorkState[] = [
  "needs_you",
  "needs_review",
  "error",
];

/** Order the rows: the ones that need a person first, quiet ones last. */
const STATE_ORDER: Record<TeamWorkState, number> = {
  needs_you: 0,
  needs_review: 1,
  error: 2,
  working: 3,
  retrying: 4,
  paused: 5,
  waiting: 6,
  quiet: 7,
};

const CLOSED_ISSUE_STATUSES = new Set(["done", "cancelled"]);

/** The status a task sits in once an agent has handed it back to a person. */
const REVIEW_ISSUE_STATUS = "in_review";

function isOpenIssue(issue: Issue): boolean {
  return !CLOSED_ISSUE_STATUSES.has(issue.status);
}

function taskFromIssue(issue: Issue): TeamWorkTask {
  return { issueId: issue.id, identifier: issue.identifier ?? null, title: issue.title };
}

function pauseDetail(agent: Agent): string {
  if (agent.pauseReason === "budget") return "It was paused by a budget hard stop.";
  if (agent.pauseReason === "system") return "It was paused by the system.";
  return "It was paused by hand.";
}

/** How much of an adapter's error text to put on a card. */
const ERROR_DETAIL_MAX_CHARS = 160;

/**
 * What to say when the agent stopped and nothing recorded why. Deliberately
 * not "open its page to find out", because this same sentence is shown ON
 * that page.
 */
const NO_ERROR_REASON = "No reason was recorded.";

/**
 * Why this agent stopped, in as much of its own words as fits on one line.
 *
 * An adapter error is often a stack trace or a wall of output, so only the
 * first meaningful line is used and it is cut short. When there is nothing
 * recorded, or the reader is not allowed to see it, the row says so rather
 * than pretending to know.
 */
function errorDetail(agent: Agent): string {
  const raw = typeof agent.lastError === "string" ? agent.lastError.trim() : "";
  if (!raw) return NO_ERROR_REASON;
  const firstLine = raw.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
  if (!firstLine) return NO_ERROR_REASON;
  return firstLine.length > ERROR_DETAIL_MAX_CHARS
    ? `${firstLine.slice(0, ERROR_DETAIL_MAX_CHARS - 1)}…`
    : firstLine;
}

function countedTasks(count: number): string {
  return count === 1 ? "1 task assigned." : `${count} tasks assigned.`;
}

function countedReviews(count: number): string {
  return count === 1
    ? "1 finished task is waiting on you."
    : `${count} finished tasks are waiting on you.`;
}

/** Dates arrive as ISO strings despite the shared types saying Date. */
function toIso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** The newer of two moments, ignoring the ones that are missing. */
function laterOf(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

/**
 * The last moment a live run is known to have done something. Prefers the
 * agent's own declared useful action over raw output, because a run can
 * print a great deal without getting anywhere.
 */
function runLastActivity(run: LiveRunForIssue): string | null {
  return laterOf(
    toIso(run.lastUsefulActionAt ?? null),
    toIso(run.outputSilence?.lastOutputAt ?? null),
  );
}

export interface TeamCurrentWorkInput {
  agents: Agent[];
  liveRuns: LiveRunForIssue[];
  issues: Issue[];
  pendingInteractions: PendingCompanyInteraction[];
  now?: number;
}

/**
 * Turn the four things the company already reports (agents, live runs, tasks
 * and pending questions) into one row per agent saying what it is doing.
 */
export function buildTeamCurrentWork(input: TeamCurrentWorkInput): TeamAgentWork[] {
  const now = input.now ?? Date.now();
  const issueById = new Map<string, Issue>();
  for (const issue of input.issues) issueById.set(issue.id, issue);

  const rows: TeamAgentWork[] = [];

  for (const agent of input.agents) {
    if (agent.status === "terminated") continue;

    const runs = input.liveRuns.filter((run) => run.agentId === agent.id);
    const activeRun = runs.find((run) => run.status === "running" || run.status === "queued") ?? null;
    const retryRun = runs.find((run) => run.status === "scheduled_retry") ?? null;
    const question = input.pendingInteractions.find((i) => i.createdByAgentId === agent.id) ?? null;

    const assignedOpen = input.issues
      .filter((issue) => issue.assigneeAgentId === agent.id && isOpenIssue(issue))
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    // Work the agent has handed back. This is the signal that was missing
    // before: an agent with nothing running is not necessarily idle, it may
    // have finished and be waiting on a person.
    const reviewWaiting = assignedOpen
      .filter((issue) => issue.status === REVIEW_ISSUE_STATUS)
      .map(taskFromIssue);

    const wakeAt = nextWakeAtMs(agent);

    let state: TeamWorkState;
    let line: string;
    let detail: string | null = null;
    let detailTone: RunNowLine["tone"] | null = null;
    let task: TeamWorkTask | null = null;
    let runId: string | null = null;
    let runStartedAt: string | null = null;
    let lastActivityAt: string | null = toIso(agent.lastHeartbeatAt);

    if (question) {
      state = "needs_you";
      line = "Asked you a question and is waiting for the answer.";
      task = {
        issueId: question.issueId,
        identifier: question.issueIdentifier ?? null,
        title: question.issueTitle,
      };
    } else if (activeRun) {
      state = "working";
      runId = activeRun.id;
      runStartedAt = toIso(activeRun.startedAt);
      lastActivityAt = laterOf(runLastActivity(activeRun), lastActivityAt);
      const issue = activeRun.issueId ? issueById.get(activeRun.issueId) : undefined;
      if (issue) task = taskFromIssue(issue);
      line = activeRun.status === "queued" ? "Queued to start." : "Running now.";
      const health = runNowLine(activeRun, now);
      detail = health?.text ?? null;
      detailTone = health?.tone ?? null;
    } else if (retryRun) {
      state = "retrying";
      runId = retryRun.id;
      runStartedAt = toIso(retryRun.startedAt);
      lastActivityAt = laterOf(runLastActivity(retryRun), lastActivityAt);
      const issue = retryRun.issueId ? issueById.get(retryRun.issueId) : undefined;
      if (issue) task = taskFromIssue(issue);
      const retry = runNowLine(retryRun, now);
      line = retry?.text ? `${retry.text}.` : "Will start again on its own.";
      detailTone = retry?.tone ?? null;
    } else if (agent.status === "error") {
      state = "error";
      line = "Stopped with an error.";
      detail = errorDetail(agent);
      detailTone = "err";
      if (assignedOpen[0]) task = taskFromIssue(assignedOpen[0]);
    } else if (agent.status === "paused") {
      state = "paused";
      line = "Paused, so nothing new will start.";
      detail = pauseDetail(agent);
      if (assignedOpen[0]) task = taskFromIssue(assignedOpen[0]);
    } else if (reviewWaiting.length > 0) {
      state = "needs_review";
      line = "Finished and handed the work back to you.";
      detail = countedReviews(reviewWaiting.length);
      task = reviewWaiting[0]!;
    } else if (wakeAt !== null) {
      state = "waiting";
      line = `Asleep, ${formatNextWake(wakeAt, now)}.`;
      if (assignedOpen[0]) task = taskFromIssue(assignedOpen[0]);
      detail = assignedOpen.length > 0 ? countedTasks(assignedOpen.length) : null;
    } else {
      state = "quiet";
      line = "Nothing running.";
      if (assignedOpen[0]) task = taskFromIssue(assignedOpen[0]);
      detail = assignedOpen.length > 0 ? countedTasks(assignedOpen.length) : "Nothing assigned.";
    }

    rows.push({
      agent,
      state,
      line,
      detail,
      detailTone,
      task,
      runId,
      runStartedAt,
      lastActivityAt,
      assignedOpenCount: assignedOpen.length,
      reviewWaiting,
      needsAttention: TEAM_ATTENTION_STATES.includes(state),
    });
  }

  return rows.sort((a, b) => {
    const byState = STATE_ORDER[a.state] - STATE_ORDER[b.state];
    if (byState !== 0) return byState;
    return a.agent.name.localeCompare(b.agent.name);
  });
}

/** Count per state, for the filter row. */
export function countTeamWorkStates(rows: TeamAgentWork[]): Record<TeamWorkState, number> {
  const counts: Record<TeamWorkState, number> = {
    needs_you: 0,
    needs_review: 0,
    working: 0,
    retrying: 0,
    error: 0,
    paused: 0,
    waiting: 0,
    quiet: 0,
  };
  for (const row of rows) counts[row.state] += 1;
  return counts;
}

/** How many rows are waiting on a person rather than on an agent. */
export function countTeamAttention(rows: TeamAgentWork[]): number {
  return rows.filter((row) => row.needsAttention).length;
}
