import { describe, expect, it } from "vitest";
import type { Agent, HeartbeatRun, Issue } from "@paperclipai/shared";
import {
  buildTeamTimeline,
  formatBusyTime,
  orderTimelineByOrganization,
  teamTimelineTicks,
  timelinePercent,
  type TeamTimelineRow,
} from "./team-timeline";
import { buildTeamHierarchy } from "./team-hierarchy";

const NOW = Date.parse("2026-09-09T15:00:00.000Z");
const HOUR = 60 * 60_000;
const MIN = 60_000;

function agent(overrides: Partial<Agent> & { id: string; name: string }): Agent {
  return {
    companyId: "company-1",
    urlKey: overrides.id,
    role: "worker",
    title: null,
    icon: null,
    status: "active",
    adapterType: "claude",
    pauseReason: null,
    pausedAt: null,
    lastHeartbeatAt: null,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    ...overrides,
  } as unknown as Agent;
}

function run(
  overrides: Partial<HeartbeatRun> & { id: string; agentId: string },
): HeartbeatRun {
  return {
    companyId: "company-1",
    invocationSource: "timer",
    triggerDetail: null,
    status: "succeeded",
    startedAt: null,
    finishedAt: null,
    error: null,
    contextSnapshot: null,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    ...overrides,
  } as unknown as HeartbeatRun;
}

function issue(overrides: Partial<Issue> & { id: string; title: string }): Issue {
  return {
    companyId: "company-1",
    identifier: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    updatedAt: new Date(NOW).toISOString(),
    createdAt: new Date(NOW).toISOString(),
    ...overrides,
  } as unknown as Issue;
}

function build(input: {
  agents: Agent[];
  runs?: HeartbeatRun[];
  issues?: Issue[];
  fromMs?: number;
  toMs?: number;
}) {
  return buildTeamTimeline({
    agents: input.agents,
    runs: input.runs ?? [],
    issues: input.issues ?? [],
    fromMs: input.fromMs ?? NOW - 2 * HOUR,
    toMs: input.toMs ?? NOW,
  });
}

describe("buildTeamTimeline", () => {
  it("gives every team member a row, even one that did nothing", () => {
    const rows = build({
      agents: [agent({ id: "a1", name: "Busy" }), agent({ id: "a2", name: "Quiet" })],
      runs: [
        run({
          id: "r1",
          agentId: "a1",
          startedAt: new Date(NOW - 30 * MIN),
          finishedAt: new Date(NOW - 20 * MIN),
        }),
      ],
    });

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.agent.name)).toEqual(["Busy", "Quiet"]);
    expect(rows[1]!.blocks).toHaveLength(0);
    expect(rows[1]!.busyMs).toBe(0);
  });

  it("names the task a run was on when the run recorded one", () => {
    const rows = build({
      agents: [agent({ id: "a1", name: "Mail triage" })],
      runs: [
        run({
          id: "r1",
          agentId: "a1",
          startedAt: new Date(NOW - 30 * MIN),
          finishedAt: new Date(NOW - 20 * MIN),
          contextSnapshot: { issueId: "i1" },
        }),
      ],
      issues: [issue({ id: "i1", identifier: "PAP-42", title: "Prepare the reply" })],
    });

    const block = rows[0]!.blocks[0]!;
    expect(block.label).toBe("PAP-42");
    expect(block.taskHref).toBe("/issues/PAP-42");
    expect(block.title).toContain("Prepare the reply");
  });

  it("says why a run happened when it was not on a task", () => {
    const rows = build({
      agents: [agent({ id: "a1", name: "Mail triage" })],
      runs: [
        run({
          id: "r1",
          agentId: "a1",
          invocationSource: "on_demand",
          startedAt: new Date(NOW - 30 * MIN),
          finishedAt: new Date(NOW - 20 * MIN),
        }),
      ],
    });

    expect(rows[0]!.blocks[0]!.label).toBe("Started by hand");
  });

  it("clips a run that began before the window and says it was clipped", () => {
    const rows = build({
      agents: [agent({ id: "a1", name: "Long runner" })],
      runs: [
        run({
          id: "r1",
          agentId: "a1",
          startedAt: new Date(NOW - 5 * HOUR),
          finishedAt: new Date(NOW - 30 * MIN),
        }),
      ],
    });

    const block = rows[0]!.blocks[0]!;
    expect(block.startMs).toBe(NOW - 2 * HOUR);
    expect(block.startsBeforeWindow).toBe(true);
    expect(block.endMs).toBe(NOW - 30 * MIN);
  });

  it("runs an unfinished run to the right-hand edge and marks it ongoing", () => {
    const rows = build({
      agents: [agent({ id: "a1", name: "Still going" })],
      runs: [
        run({ id: "r1", agentId: "a1", status: "running", startedAt: new Date(NOW - 10 * MIN) }),
      ],
    });

    const block = rows[0]!.blocks[0]!;
    expect(block.ongoing).toBe(true);
    expect(block.endMs).toBe(NOW);
    expect(block.tone).toBe("running");
  });

  it("leaves out a run that finished before the window opened", () => {
    const rows = build({
      agents: [agent({ id: "a1", name: "Yesterday" })],
      runs: [
        run({
          id: "r1",
          agentId: "a1",
          startedAt: new Date(NOW - 6 * HOUR),
          finishedAt: new Date(NOW - 5 * HOUR),
        }),
      ],
    });

    expect(rows[0]!.blocks).toHaveLength(0);
  });

  it("counts overlapping runs once, so busy time can never exceed the window", () => {
    const rows = build({
      agents: [agent({ id: "a1", name: "Overlapper" })],
      runs: [
        run({
          id: "r1",
          agentId: "a1",
          startedAt: new Date(NOW - 60 * MIN),
          finishedAt: new Date(NOW - 30 * MIN),
        }),
        run({
          id: "r2",
          agentId: "a1",
          startedAt: new Date(NOW - 45 * MIN),
          finishedAt: new Date(NOW - 15 * MIN),
        }),
      ],
    });

    expect(rows[0]!.busyMs).toBe(45 * MIN);
  });

  it("puts the busiest member at the top", () => {
    const rows = build({
      agents: [agent({ id: "a1", name: "Aardvark" }), agent({ id: "a2", name: "Zebra" })],
      runs: [
        run({
          id: "r1",
          agentId: "a1",
          startedAt: new Date(NOW - 20 * MIN),
          finishedAt: new Date(NOW - 15 * MIN),
        }),
        run({
          id: "r2",
          agentId: "a2",
          startedAt: new Date(NOW - 60 * MIN),
          finishedAt: new Date(NOW - 10 * MIN),
        }),
      ],
    });

    expect(rows.map((row) => row.agent.name)).toEqual(["Zebra", "Aardvark"]);
  });

  it("draws a paused band only for a member that is paused right now", () => {
    const rows = build({
      agents: [
        agent({ id: "a1", name: "Halted", status: "paused", pausedAt: new Date(NOW - 40 * MIN) }),
        agent({ id: "a2", name: "Fine" }),
      ],
    });

    const halted = rows.find((row) => row.agent.name === "Halted")!;
    const fine = rows.find((row) => row.agent.name === "Fine")!;
    expect(halted.pausedFromMs).toBe(NOW - 40 * MIN);
    expect(fine.pausedFromMs).toBeNull();
  });

  it("starts the paused band at the left edge when the pause predates the window", () => {
    const rows = build({
      agents: [
        agent({ id: "a1", name: "Halted", status: "paused", pausedAt: new Date(NOW - 9 * HOUR) }),
      ],
    });

    expect(rows[0]!.pausedFromMs).toBe(NOW - 2 * HOUR);
  });

  it("leaves terminated members out entirely", () => {
    const rows = build({
      agents: [agent({ id: "a1", name: "Gone", status: "terminated" })],
    });

    expect(rows).toHaveLength(0);
  });

  it("colours a failed run differently from one that finished", () => {
    const rows = build({
      agents: [agent({ id: "a1", name: "Mixed" })],
      runs: [
        run({
          id: "r1",
          agentId: "a1",
          status: "failed",
          error: "the adapter fell over",
          startedAt: new Date(NOW - 30 * MIN),
          finishedAt: new Date(NOW - 29 * MIN),
        }),
        run({
          id: "r2",
          agentId: "a1",
          status: "succeeded",
          startedAt: new Date(NOW - 20 * MIN),
          finishedAt: new Date(NOW - 19 * MIN),
        }),
      ],
    });

    const [first, second] = rows[0]!.blocks;
    expect(first!.tone).toBe("failed");
    expect(first!.title).toContain("the adapter fell over");
    expect(second!.tone).toBe("succeeded");
  });

  it("points each bar at that run's own page under its agent", () => {
    const rows = build({
      agents: [agent({ id: "a1", name: "Mail triage", urlKey: "mail-triage" } as never)],
      runs: [
        run({
          id: "run-1",
          agentId: "a1",
          startedAt: new Date(NOW - 10 * MIN),
          finishedAt: new Date(NOW - 5 * MIN),
        }),
      ],
    });

    expect(rows[0]!.blocks[0]!.runHref).toBe("/agents/mail-triage/runs/run-1");
  });
});

describe("timelinePercent", () => {
  it("puts the left edge at nothing and the right edge at everything", () => {
    expect(timelinePercent(NOW - 2 * HOUR, NOW - 2 * HOUR, NOW)).toBe(0);
    expect(timelinePercent(NOW, NOW - 2 * HOUR, NOW)).toBe(100);
    expect(timelinePercent(NOW - HOUR, NOW - 2 * HOUR, NOW)).toBe(50);
  });
});

describe("teamTimelineTicks", () => {
  it("gives a handful of gridlines on round minutes", () => {
    const ticks = teamTimelineTicks(NOW - 2 * HOUR, NOW);
    expect(ticks.length).toBeGreaterThan(3);
    expect(ticks.length).toBeLessThan(10);
    for (const tick of ticks) expect(tick % (5 * MIN)).toBe(0);
  });

  it("returns nothing for a window with no width", () => {
    expect(teamTimelineTicks(NOW, NOW)).toEqual([]);
  });
});

describe("formatBusyTime", () => {
  it("says it plainly", () => {
    expect(formatBusyTime(0)).toBe("nothing");
    expect(formatBusyTime(20_000)).toBe("under a minute");
    expect(formatBusyTime(12 * MIN)).toBe("12m");
    expect(formatBusyTime(64 * MIN)).toBe("1h 04m");
    expect(formatBusyTime(120 * MIN)).toBe("2h");
  });
});

describe("orderTimelineByOrganization", () => {
  function company() {
    return [
      agent({ id: "ceo", name: "Ada", role: "ceo" }),
      agent({ id: "cto", name: "Cass", role: "cto", reportsTo: "ceo" }),
      agent({ id: "em", name: "Erin", role: "pm", reportsTo: "cto" }),
      agent({ id: "dev", name: "Devi", role: "engineer", reportsTo: "em" }),
      agent({ id: "cmo", name: "Mo", role: "cmo", reportsTo: "ceo" }),
    ];
  }

  function rowsFor(agents: Agent[]): TeamTimelineRow[] {
    return agents.map((one) => ({ agent: one, blocks: [], busyMs: 0, pausedFromMs: null }));
  }

  it("leads with the top of the company under its own heading", () => {
    const agents = company();
    const entries = orderTimelineByOrganization(rowsFor(agents), buildTeamHierarchy(agents));
    expect(entries[0]).toMatchObject({ kind: "heading", title: "Executive leadership" });
    expect(entries[1]).toMatchObject({ kind: "row", depth: 0 });
    expect((entries[1] as { row: TeamTimelineRow }).row.agent.id).toBe("ceo");
  });

  it("indents each member by how deep they sit under their executive", () => {
    const agents = company();
    const entries = orderTimelineByOrganization(rowsFor(agents), buildTeamHierarchy(agents));
    const depths = new Map(
      entries
        .filter((entry) => entry.kind === "row")
        .map((entry) => {
          const row = entry as { row: TeamTimelineRow; depth: number };
          return [row.row.agent.id, row.depth];
        }),
    );
    // Relative to the CTO's heading, not to the top of the company.
    expect(depths.get("cto")).toBe(0);
    expect(depths.get("em")).toBe(1);
    expect(depths.get("dev")).toBe(2);
  });

  it("names each member's manager for the tooltip", () => {
    const agents = company();
    const entries = orderTimelineByOrganization(rowsFor(agents), buildTeamHierarchy(agents));
    const dev = entries.find(
      (entry) => entry.kind === "row" && entry.row.agent.id === "dev",
    ) as { managerName: string | null };
    expect(dev.managerName).toBe("Erin");
  });

  it("lists everybody exactly once", () => {
    const agents = company();
    const entries = orderTimelineByOrganization(rowsFor(agents), buildTeamHierarchy(agents));
    const ids = entries.filter((entry) => entry.kind === "row").map((entry) => (entry as { row: TeamTimelineRow }).row.agent.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(["ceo", "cmo", "cto", "dev", "em"]);
  });

  it("puts anyone outside the reporting line in their own group at the end", () => {
    const agents = [...company(), agent({ id: "loose", name: "Loose" })];
    const entries = orderTimelineByOrganization(rowsFor(agents), buildTeamHierarchy(agents));
    const headings = entries.filter((entry) => entry.kind === "heading");
    expect(headings[headings.length - 1]).toMatchObject({ title: "Not in the reporting line" });
    expect(entries[entries.length - 1]).toMatchObject({ kind: "row" });
    expect((entries[entries.length - 1] as { row: TeamTimelineRow }).row.agent.id).toBe("loose");
  });

  it("skips a heading for an organization with nobody to draw", () => {
    const agents = company();
    // Only the marketing side has a row this window.
    const rows = rowsFor(agents.filter((one) => one.id === "cmo"));
    const entries = orderTimelineByOrganization(rows, buildTeamHierarchy(agents));
    expect(entries.filter((entry) => entry.kind === "heading").map((entry) => (entry as { title: string }).title)).toEqual(["Mo"]);
  });
});
