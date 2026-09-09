import { describe, expect, it } from "vitest";
import type { Agent, Issue } from "@paperclipai/shared";
import type { LiveRunForIssue } from "../api/heartbeats";
import type { PendingCompanyInteraction } from "../api/issues";
import {
  buildTeamCurrentWork,
  countTeamWorkStates,
  TEAM_WORK_STATE_LABELS,
} from "./team-current-work";

const NOW = Date.parse("2026-09-07T12:00:00.000Z");

function agent(overrides: Partial<Agent> & { id: string; name: string }): Agent {
  return {
    companyId: "company-1",
    urlKey: overrides.id,
    role: "worker",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false, canAssignTasks: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    ...overrides,
  } as unknown as Agent;
}

function issue(overrides: Partial<Issue> & { id: string; title: string }): Issue {
  return {
    companyId: "company-1",
    identifier: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    updatedAt: new Date(NOW).toISOString(),
    createdAt: new Date(NOW).toISOString(),
    ...overrides,
  } as unknown as Issue;
}

function run(overrides: Partial<LiveRunForIssue> & { id: string; agentId: string }): LiveRunForIssue {
  return {
    status: "running",
    invocationSource: "scheduler",
    triggerDetail: null,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date(NOW).toISOString(),
    agentName: "agent",
    adapterType: "claude",
    ...overrides,
  } as unknown as LiveRunForIssue;
}

function question(
  overrides: Partial<PendingCompanyInteraction> & { id: string; createdByAgentId: string },
): PendingCompanyInteraction {
  return {
    companyId: "company-1",
    issueId: "issue-q",
    issueIdentifier: "PAP-9",
    issueTitle: "Choose a supplier",
    kind: "ask_user_questions",
    status: "pending",
    ...overrides,
  } as unknown as PendingCompanyInteraction;
}

function build(input: {
  agents: Agent[];
  liveRuns?: LiveRunForIssue[];
  issues?: Issue[];
  pendingInteractions?: PendingCompanyInteraction[];
}) {
  return buildTeamCurrentWork({
    agents: input.agents,
    liveRuns: input.liveRuns ?? [],
    issues: input.issues ?? [],
    pendingInteractions: input.pendingInteractions ?? [],
    now: NOW,
  });
}

describe("buildTeamCurrentWork", () => {
  it("says an agent is working, and names the task the run is on", () => {
    const rows = build({
      agents: [agent({ id: "a1", name: "Mail triage" })],
      liveRuns: [run({ id: "r1", agentId: "a1", status: "running", issueId: "i1" })],
      issues: [issue({ id: "i1", title: "Prepare the customer reply", identifier: "PAP-42" })],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("working");
    expect(rows[0]!.line).toBe("Running now.");
    expect(rows[0]!.task).toEqual({
      issueId: "i1",
      identifier: "PAP-42",
      title: "Prepare the customer reply",
    });
    expect(rows[0]!.runId).toBe("r1");
  });

  it("marks a queued run as working but does not claim it is running", () => {
    const rows = build({
      agents: [agent({ id: "a1", name: "Mail triage" })],
      liveRuns: [run({ id: "r1", agentId: "a1", status: "queued" })],
    });

    expect(rows[0]!.state).toBe("working");
    expect(rows[0]!.line).toBe("Queued to start.");
    expect(rows[0]!.detail).toBe("Waiting for a free slot");
  });

  it("adds the run's own quiet warning as the second line", () => {
    const rows = build({
      agents: [agent({ id: "a1", name: "Mail triage" })],
      liveRuns: [
        run({
          id: "r1",
          agentId: "a1",
          status: "running",
          outputSilence: {
            level: "suspicious",
            silenceStartedAt: new Date(NOW - 12 * 60_000).toISOString(),
          } as LiveRunForIssue["outputSilence"],
        }),
      ],
    });

    expect(rows[0]!.detail).toBe("Quiet for 12m");
  });

  it("puts an agent that asked a question at the top, above one that is working", () => {
    const rows = build({
      agents: [
        agent({ id: "a1", name: "Aardvark" }),
        agent({ id: "a2", name: "Zebra" }),
      ],
      liveRuns: [run({ id: "r1", agentId: "a1", status: "running" })],
      pendingInteractions: [question({ id: "q1", createdByAgentId: "a2" })],
    });

    expect(rows.map((row) => row.agent.name)).toEqual(["Zebra", "Aardvark"]);
    expect(rows[0]!.state).toBe("needs_you");
    expect(rows[0]!.line).toBe("Asked you a question and is waiting for the answer.");
    expect(rows[0]!.task).toEqual({
      issueId: "issue-q",
      identifier: "PAP-9",
      title: "Choose a supplier",
    });
  });

  it("reports a run that will start itself again, with the time", () => {
    const rows = build({
      agents: [agent({ id: "a1", name: "Mail triage" })],
      liveRuns: [
        run({
          id: "r1",
          agentId: "a1",
          status: "scheduled_retry",
          scheduledRetryAt: null,
        }),
      ],
    });

    expect(rows[0]!.state).toBe("retrying");
    expect(rows[0]!.line).toBe("Will retry on its own.");
  });

  it("says why an agent is paused", () => {
    const rows = build({
      agents: [agent({ id: "a1", name: "Mail triage", status: "paused", pauseReason: "budget" })],
    });

    expect(rows[0]!.state).toBe("paused");
    expect(rows[0]!.line).toBe("Paused, so nothing new will start.");
    expect(rows[0]!.detail).toBe("It was paused by a budget hard stop.");
  });

  it("reports an agent in an error state", () => {
    const rows = build({
      agents: [agent({ id: "a1", name: "Mail triage", status: "error" })],
    });

    expect(rows[0]!.state).toBe("error");
    expect(rows[0]!.line).toBe("Stopped with an error.");
  });

  it("says when a scheduled agent is asleep and when it wakes", () => {
    const rows = build({
      agents: [
        agent({
          id: "a1",
          name: "Monitor",
          schedulerActive: true,
          heartbeatIntervalSec: 3600,
          lastHeartbeatAt: new Date(NOW - 40 * 60_000),
        }),
      ],
    });

    expect(rows[0]!.state).toBe("waiting");
    expect(rows[0]!.line).toBe("Asleep, wakes in 20m.");
  });

  it("counts the open tasks an agent holds, ignoring finished ones", () => {
    const rows = build({
      agents: [agent({ id: "a1", name: "Operations" })],
      issues: [
        issue({ id: "i1", title: "Reconcile invoices", assigneeAgentId: "a1", status: "todo" }),
        issue({ id: "i2", title: "Old thing", assigneeAgentId: "a1", status: "done" }),
        issue({ id: "i3", title: "Dropped thing", assigneeAgentId: "a1", status: "cancelled" }),
        issue({ id: "i4", title: "Someone else's", assigneeAgentId: "a2", status: "todo" }),
      ],
    });

    expect(rows[0]!.state).toBe("quiet");
    expect(rows[0]!.assignedOpenCount).toBe(1);
    expect(rows[0]!.line).toBe("Nothing running.");
    expect(rows[0]!.detail).toBe("1 task assigned.");
    expect(rows[0]!.task?.title).toBe("Reconcile invoices");
  });

  it("is honest when there is nothing to report", () => {
    const rows = build({ agents: [agent({ id: "a1", name: "Spare" })] });

    expect(rows[0]!.state).toBe("quiet");
    expect(rows[0]!.detail).toBe("Nothing assigned.");
    expect(rows[0]!.task).toBeNull();
  });

  it("leaves terminated agents out", () => {
    const rows = build({
      agents: [
        agent({ id: "a1", name: "Gone", status: "terminated" }),
        agent({ id: "a2", name: "Here" }),
      ],
    });

    expect(rows.map((row) => row.agent.name)).toEqual(["Here"]);
  });

  it("counts the states for the filter row", () => {
    const rows = build({
      agents: [
        agent({ id: "a1", name: "One" }),
        agent({ id: "a2", name: "Two" }),
        agent({ id: "a3", name: "Three", status: "paused" }),
      ],
      liveRuns: [run({ id: "r1", agentId: "a1", status: "running" })],
    });

    const counts = countTeamWorkStates(rows);
    expect(counts.working).toBe(1);
    expect(counts.paused).toBe(1);
    expect(counts.quiet).toBe(1);
    expect(counts.needs_you).toBe(0);
  });

  it("has a plain-words label for every state it can produce", () => {
    for (const state of Object.keys(TEAM_WORK_STATE_LABELS)) {
      expect(TEAM_WORK_STATE_LABELS[state as keyof typeof TEAM_WORK_STATE_LABELS]).toBeTruthy();
    }
  });
});
