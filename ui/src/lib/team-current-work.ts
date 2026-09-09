import type { Agent, Issue } from "@paperclipai/shared";
import type { LiveRunForIssue } from "../api/heartbeats";
import type { PendingCompanyInteraction } from "../api/issues";
import { formatNextWake, nextWakeAtMs } from "./next-wake";
import { runNowLine } from "./run-now-line";

/**
 * What one agent is doing right now, for the Team page's opening view.
 *
 * Every state below is read from something the app already stores: a live
 * run, a question the agent asked and is waiting on, the agent's own paused
 * or error status, its scheduler wake time, or the tasks assigned to it.
 * Nothing here is guessed.
 *
 * Deliberately NOT modelled, because the app has no such field: an agent's
 * objective, and who owns the next action on a piece of work. The mockup
 * shows both. Assigned work and the reporting line are the closest real
 * data, and inventing the rest would put a confident sentence on screen
 * that nothing underneath can support.
 */
export type TeamWorkState =
  | "needs_you"
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
  task: TeamWorkTask | null;
  /** The run to link to, when one is live. */
  runId: string | null;
  /** Open tasks assigned to this agent. */
  assignedOpenCount: number;
}

/** Short label for the state pill. */
export const TEAM_WORK_STATE_LABELS: Record<TeamWorkState, string> = {
  needs_you: "Needs you",
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
  working: "A run for this agent is going right now.",
  retrying: "A run stopped and the agent will start it again on its own.",
  error: "The agent is in an error state and will not pick work up until it is sorted out.",
  paused: "The agent is paused, so no new run will start.",
  waiting: "The agent is not running anything and is due to wake on its schedule.",
  quiet: "Nothing is running and no wake time is set.",
};

/** Order the rows: the ones that need a person first, quiet ones last. */
const STATE_ORDER: Record<TeamWorkState, number> = {
  needs_you: 0,
  working: 1,
  retrying: 2,
  error: 3,
  paused: 4,
  waiting: 5,
  quiet: 6,
};

const CLOSED_ISSUE_STATUSES = new Set(["done", "cancelled"]);

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

function countedTasks(count: number): string {
  return count === 1 ? "1 task assigned." : `${count} tasks assigned.`;
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

    const wakeAt = nextWakeAtMs(agent);

    let state: TeamWorkState;
    let line: string;
    let detail: string | null = null;
    let task: TeamWorkTask | null = null;
    let runId: string | null = null;

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
      const issue = activeRun.issueId ? issueById.get(activeRun.issueId) : undefined;
      if (issue) task = taskFromIssue(issue);
      line = activeRun.status === "queued" ? "Queued to start." : "Running now.";
      detail = runNowLine(activeRun, now)?.text ?? null;
    } else if (retryRun) {
      state = "retrying";
      runId = retryRun.id;
      const issue = retryRun.issueId ? issueById.get(retryRun.issueId) : undefined;
      if (issue) task = taskFromIssue(issue);
      const retryText = runNowLine(retryRun, now)?.text;
      line = retryText ? `${retryText}.` : "Will start again on its own.";
    } else if (agent.status === "error") {
      state = "error";
      line = "Stopped with an error.";
      if (assignedOpen[0]) task = taskFromIssue(assignedOpen[0]);
    } else if (agent.status === "paused") {
      state = "paused";
      line = "Paused, so nothing new will start.";
      detail = pauseDetail(agent);
      if (assignedOpen[0]) task = taskFromIssue(assignedOpen[0]);
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
      task,
      runId,
      assignedOpenCount: assignedOpen.length,
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
