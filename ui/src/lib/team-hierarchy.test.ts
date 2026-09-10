import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";
import {
  branchMemberIds,
  buildAttentionList,
  buildTeamHierarchy,
  chainOfCommand,
  describeRollup,
  groupRowsByBranch,
  hierarchyReadingOrder,
  isManager,
  isUnder,
  managerOf,
  orgContextFor,
  rollupForManager,
  UNATTACHED_GROUP_TITLE,
} from "./team-hierarchy";
import type { TeamAgentWork, TeamWorkState } from "./team-current-work";

function agent(overrides: Partial<Agent> & { id: string; name: string }): Agent {
  return {
    companyId: "company-1",
    urlKey: overrides.name.toLowerCase().replace(/\s+/g, "-"),
    role: "general",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  } as Agent;
}

function row(target: Agent, state: TeamWorkState): TeamAgentWork {
  return {
    agent: target,
    state,
    line: "",
    detail: null,
    detailTone: null,
    task: null,
    runId: null,
    runStartedAt: null,
    lastActivityAt: null,
    assignedOpenCount: 0,
    reviewWaiting: [],
    needsAttention: ["needs_you", "needs_review", "error"].includes(state),
  };
}

/**
 * The shape from the brief: a CEO, three executives, a manager under one of
 * them, and individual contributors under the manager.
 */
function exampleCompany() {
  const ceo = agent({ id: "ceo", name: "Ada", role: "ceo" });
  const cto = agent({ id: "cto", name: "Cass", role: "cto", reportsTo: "ceo" });
  const cmo = agent({ id: "cmo", name: "Mo", role: "cmo", reportsTo: "ceo" });
  const cfo = agent({ id: "cfo", name: "Fin", role: "cfo", reportsTo: "ceo" });
  const engManager = agent({ id: "em", name: "Eng Manager", role: "pm", reportsTo: "cto" });
  const backend = agent({ id: "be", name: "Backend Dev", role: "engineer", reportsTo: "em" });
  const qa = agent({ id: "qa", name: "QA", role: "qa", reportsTo: "em" });
  const devops = agent({ id: "do", name: "DevOps", role: "devops", reportsTo: "cto" });
  const copywriter = agent({ id: "cw", name: "Copywriter", role: "general", reportsTo: "cmo" });
  return { ceo, cto, cmo, cfo, engManager, backend, qa, devops, copywriter };
}

function exampleAgents(): Agent[] {
  return Object.values(exampleCompany());
}

describe("buildTeamHierarchy", () => {
  it("finds the single agent with no manager as the top", () => {
    const hierarchy = buildTeamHierarchy(exampleAgents());
    expect(hierarchy.topId).toBe("ceo");
    expect(hierarchy.rootIds).toEqual(["ceo"]);
  });

  it("makes each of the CEO's direct reports a branch, and nobody else", () => {
    const hierarchy = buildTeamHierarchy(exampleAgents());
    expect(hierarchy.branches.map((branch) => branch.id).sort()).toEqual(["cfo", "cmo", "cto"]);
  });

  it("puts everyone beneath an executive into that executive's branch", () => {
    const hierarchy = buildTeamHierarchy(exampleAgents());
    // Two levels down still belongs to the CTO, not to the engineering manager.
    expect(hierarchy.byId.get("be")?.branchId).toBe("cto");
    expect(hierarchy.byId.get("qa")?.branchId).toBe("cto");
    expect(hierarchy.byId.get("cw")?.branchId).toBe("cmo");
  });

  it("gives the top no branch of its own, because it is over all of them", () => {
    const hierarchy = buildTeamHierarchy(exampleAgents());
    expect(hierarchy.byId.get("ceo")?.branchId).toBeNull();
  });

  it("records depth from the top", () => {
    const hierarchy = buildTeamHierarchy(exampleAgents());
    expect(hierarchy.byId.get("ceo")?.depth).toBe(0);
    expect(hierarchy.byId.get("cto")?.depth).toBe(1);
    expect(hierarchy.byId.get("em")?.depth).toBe(2);
    expect(hierarchy.byId.get("be")?.depth).toBe(3);
  });

  it("counts everybody beneath a manager, not just their direct reports", () => {
    const hierarchy = buildTeamHierarchy(exampleAgents());
    const cto = hierarchy.byId.get("cto")!;
    expect(cto.directReportIds.sort()).toEqual(["do", "em"]);
    expect(cto.descendantIds.sort()).toEqual(["be", "do", "em", "qa"]);
  });

  it("leaves out terminated agents and does not orphan their reports silently", () => {
    const agents = exampleAgents().map((one) =>
      one.id === "em" ? ({ ...one, status: "terminated" } as Agent) : one,
    );
    const hierarchy = buildTeamHierarchy(agents);
    expect(hierarchy.byId.has("em")).toBe(false);
    // The manager is gone, so the developer has no manager rather than a link
    // to somebody who is not on screen.
    expect(hierarchy.byId.get("be")?.managerId).toBeNull();
    expect(hierarchy.rootIds).toContain("be");
  });

  it("treats a manager who is not in the list as no manager", () => {
    const orphan = agent({ id: "x", name: "Orphan", reportsTo: "nobody" });
    const hierarchy = buildTeamHierarchy([orphan]);
    expect(hierarchy.byId.get("x")?.managerId).toBeNull();
  });

  it("does not hang on a loop in the reporting lines", () => {
    const a = agent({ id: "a", name: "A", reportsTo: "b" });
    const b = agent({ id: "b", name: "B", reportsTo: "a" });
    const hierarchy = buildTeamHierarchy([a, b]);
    // Both are shown; neither is claimed to manage the other.
    expect(hierarchy.byId.size).toBe(2);
    expect(hierarchy.rootIds.length).toBeGreaterThan(0);
  });

  it("ignores an agent that reports to itself", () => {
    const self = agent({ id: "s", name: "Self", reportsTo: "s" });
    const hierarchy = buildTeamHierarchy([self]);
    expect(hierarchy.byId.get("s")?.managerId).toBeNull();
  });

  describe("when more than one agent has no manager", () => {
    it("picks the one whose role is CEO as the top", () => {
      const agents = [...exampleAgents(), agent({ id: "loose", name: "Loose", role: "assistant" })];
      const hierarchy = buildTeamHierarchy(agents);
      expect(hierarchy.topId).toBe("ceo");
    });

    it("keeps the others out of the CEO's organization", () => {
      const agents = [...exampleAgents(), agent({ id: "loose", name: "Loose", role: "assistant" })];
      const hierarchy = buildTeamHierarchy(agents);
      expect(hierarchy.unattachedIds).toEqual(["loose"]);
      // Crucially not adopted as a branch of the CEO.
      expect(hierarchy.branches.map((branch) => branch.id)).not.toContain("loose");
      expect(hierarchy.byId.get("loose")?.branchId).toBe("loose");
    });

    it("names no top at all when two agents both claim the CEO role", () => {
      const one = agent({ id: "1", name: "One", role: "ceo" });
      const two = agent({ id: "2", name: "Two", role: "ceo" });
      const hierarchy = buildTeamHierarchy([one, two]);
      expect(hierarchy.topId).toBeNull();
      // Each stands on its own rather than one being chosen arbitrarily.
      expect(hierarchy.branches.map((branch) => branch.id).sort()).toEqual(["1", "2"]);
    });

    it("names no top when nobody at the top has the CEO role", () => {
      const one = agent({ id: "1", name: "One", role: "engineer" });
      const two = agent({ id: "2", name: "Two", role: "designer" });
      const hierarchy = buildTeamHierarchy([one, two]);
      expect(hierarchy.topId).toBeNull();
      expect(hierarchy.unattachedIds).toEqual([]);
    });
  });

  it("copes with an empty company", () => {
    const hierarchy = buildTeamHierarchy([]);
    expect(hierarchy.topId).toBeNull();
    expect(hierarchy.branches).toEqual([]);
    expect(hierarchy.rootIds).toEqual([]);
  });
});

describe("reading the tree", () => {
  it("names the manager to show on a card", () => {
    const hierarchy = buildTeamHierarchy(exampleAgents());
    expect(managerOf(hierarchy, "be")?.name).toBe("Eng Manager");
    expect(managerOf(hierarchy, "ceo")).toBeNull();
  });

  it("knows who has reports", () => {
    const hierarchy = buildTeamHierarchy(exampleAgents());
    expect(isManager(hierarchy, "cto")).toBe(true);
    expect(isManager(hierarchy, "be")).toBe(false);
  });

  it("walks the whole line above an agent, nearest first", () => {
    const hierarchy = buildTeamHierarchy(exampleAgents());
    expect(chainOfCommand(hierarchy, "be").map((one) => one.id)).toEqual(["em", "cto", "ceo"]);
  });

  it("answers who is under whom at any depth", () => {
    const hierarchy = buildTeamHierarchy(exampleAgents());
    expect(isUnder(hierarchy, "be", "cto")).toBe(true);
    expect(isUnder(hierarchy, "be", "cmo")).toBe(false);
    expect(isUnder(hierarchy, "cto", "cto")).toBe(true);
  });

  it("reads down the organization rather than across the alphabet", () => {
    const order = hierarchyReadingOrder(buildTeamHierarchy(exampleAgents()));
    expect(order[0]).toBe("ceo");
    // Everyone in the CTO's organization appears before the CMO's people.
    expect(order.indexOf("be")).toBeLessThan(order.indexOf("cw"));
  });

  it("collects an executive's whole organization for the filter", () => {
    const hierarchy = buildTeamHierarchy(exampleAgents());
    expect(branchMemberIds(hierarchy, "cto").sort()).toEqual(["be", "cto", "do", "em", "qa"]);
  });

  it("collects a middle manager's organization too, not only an executive's", () => {
    const hierarchy = buildTeamHierarchy(exampleAgents());
    expect(branchMemberIds(hierarchy, "em").sort()).toEqual(["be", "em", "qa"]);
  });
});

describe("orgContextFor", () => {
  it("does not claim somebody with no manager leads an organization", () => {
    const agents = [...exampleAgents(), agent({ id: "loose", name: "Loose" })];
    const hierarchy = buildTeamHierarchy(agents);
    const context = orgContextFor(hierarchy, "loose", new Map());
    expect(context.outsideReportingLine).toBe(true);
    expect(context.manager).toBeNull();
  });

  it("places somebody who does have a manager inside their executive's organization", () => {
    const hierarchy = buildTeamHierarchy(exampleAgents());
    const context = orgContextFor(hierarchy, "be", new Map());
    expect(context.outsideReportingLine).toBe(false);
    expect(context.branch?.id).toBe("cto");
    expect(context.leadsBranch).toBe(false);
  });

  it("marks an executive as leading their own branch", () => {
    const hierarchy = buildTeamHierarchy(exampleAgents());
    const context = orgContextFor(hierarchy, "cto", new Map());
    expect(context.leadsBranch).toBe(true);
    expect(context.isTop).toBe(false);
  });

  it("says nobody is outside the line when the company has no top at all", () => {
    const one = agent({ id: "1", name: "One" });
    const two = agent({ id: "2", name: "Two" });
    const hierarchy = buildTeamHierarchy([one, two]);
    expect(orgContextFor(hierarchy, "1", new Map()).outsideReportingLine).toBe(false);
  });
});

describe("rollupForManager", () => {
  function rowsFor(states: Record<string, TeamWorkState>) {
    const company = exampleCompany();
    const map = new Map<string, TeamAgentWork>();
    for (const one of Object.values(company)) {
      map.set(one.id, row(one, states[one.id] ?? "quiet"));
    }
    return map;
  }

  it("counts everybody beneath the manager and excludes the manager", () => {
    const hierarchy = buildTeamHierarchy(exampleAgents());
    const rows = rowsFor({ cto: "error", be: "working", qa: "error", do: "working", em: "quiet" });
    const rollup = rollupForManager(hierarchy, "cto", rows);
    expect(rollup.total).toBe(4);
    expect(rollup.directCount).toBe(2);
    expect(rollup.counts.working).toBe(2);
    expect(rollup.counts.idle).toBe(1);
    // The CTO's own error is not counted in the CTO's organization.
    expect(rollup.counts.attention).toBe(1);
  });

  it("lists the rows beneath that need a person", () => {
    const hierarchy = buildTeamHierarchy(exampleAgents());
    const rows = rowsFor({ qa: "error", be: "needs_you" });
    const rollup = rollupForManager(hierarchy, "cto", rows);
    expect(rollup.attention.map((item) => item.agent.id).sort()).toEqual(["be", "qa"]);
  });

  it("reports nothing for somebody with no reports", () => {
    const hierarchy = buildTeamHierarchy(exampleAgents());
    const rollup = rollupForManager(hierarchy, "be", rowsFor({}));
    expect(rollup.total).toBe(0);
    expect(rollup.attention).toEqual([]);
  });

  it("writes the roll-up out without empty groups", () => {
    const hierarchy = buildTeamHierarchy(exampleAgents());
    const rows = rowsFor({ be: "working", do: "working", qa: "error", em: "quiet" });
    const text = describeRollup(rollupForManager(hierarchy, "cto", rows));
    expect(text).toBe("4 people · 2 working · 1 idle · 1 needs you");
    expect(text).not.toContain("paused");
  });

  it("says people in the plural only when there is more than one", () => {
    const hierarchy = buildTeamHierarchy(exampleAgents());
    const rows = rowsFor({ cw: "working" });
    expect(describeRollup(rollupForManager(hierarchy, "cmo", rows))).toBe("1 person · 1 working");
  });
});

describe("groupRowsByBranch", () => {
  function allRows(states: Record<string, TeamWorkState> = {}) {
    const company = exampleCompany();
    const list = Object.values(company).map((one) => row(one, states[one.id] ?? "quiet"));
    return { list, byId: new Map(list.map((item) => [item.agent.id, item])) };
  }

  it("leads with the top of the company", () => {
    const { list, byId } = allRows();
    const sections = groupRowsByBranch(buildTeamHierarchy(exampleAgents()), list, byId);
    expect(sections[0]?.title).toBe("Executive leadership");
    expect(sections[0]?.leaderRow?.agent.id).toBe("ceo");
  });

  it("gives each executive their own section with their people beneath", () => {
    const { list, byId } = allRows();
    const sections = groupRowsByBranch(buildTeamHierarchy(exampleAgents()), list, byId);
    const cto = sections.find((section) => section.id === "cto")!;
    expect(cto.leaderRow?.agent.id).toBe("cto");
    expect(cto.memberRows.map((item) => item.agent.id).sort()).toEqual(["be", "do", "em", "qa"]);
  });

  it("never lists the same person in two sections", () => {
    const { list, byId } = allRows();
    const sections = groupRowsByBranch(buildTeamHierarchy(exampleAgents()), list, byId);
    const seen = sections.flatMap((section) => [
      ...(section.leaderRow ? [section.leaderRow.agent.id] : []),
      ...section.memberRows.map((item) => item.agent.id),
    ]);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(list.length);
  });

  it("shows only the rows that survived a filter, but counts the whole organization", () => {
    const { list, byId } = allRows({ qa: "error" });
    const visible = list.filter((item) => item.state === "error");
    const sections = groupRowsByBranch(buildTeamHierarchy(exampleAgents()), visible, byId);
    const cto = sections.find((section) => section.id === "cto")!;
    expect(cto.leaderRow).toBeNull();
    expect(cto.memberRows.map((item) => item.agent.id)).toEqual(["qa"]);
    // The heading still knows the CTO has four people, which is the point of
    // passing every row in as well as the visible ones.
    expect(cto.rollup?.total).toBe(4);
  });

  it("drops a section whose people were all filtered out", () => {
    const { list, byId } = allRows({ qa: "error" });
    const visible = list.filter((item) => item.state === "error");
    const sections = groupRowsByBranch(buildTeamHierarchy(exampleAgents()), visible, byId);
    expect(sections.map((section) => section.id)).toEqual(["cto"]);
  });

  it("puts anyone outside the reporting line in their own group, not under the CEO", () => {
    const agents = [...exampleAgents(), agent({ id: "loose", name: "Loose" })];
    const list = agents.map((one) => row(one, "quiet"));
    const byId = new Map(list.map((item) => [item.agent.id, item]));
    const sections = groupRowsByBranch(buildTeamHierarchy(agents), list, byId);
    const last = sections[sections.length - 1]!;
    expect(last.title).toBe(UNATTACHED_GROUP_TITLE);
    expect(last.memberRows.map((item) => item.agent.id)).toEqual(["loose"]);
  });
});

describe("buildAttentionList", () => {
  it("finds trouble anywhere in the company and says which branch it is in", () => {
    const company = exampleCompany();
    const rows = [
      row(company.qa, "error"),
      row(company.copywriter, "needs_you"),
      row(company.backend, "working"),
    ];
    const items = buildAttentionList(buildTeamHierarchy(exampleAgents()), rows);
    expect(items.map((item) => item.row.agent.id)).toEqual(["qa", "cw"]);
    expect(items[0]?.branch?.id).toBe("cto");
    expect(items[0]?.manager?.id).toBe("em");
    expect(items[1]?.branch?.id).toBe("cmo");
  });

  it("keeps the top of the company out of the unplaced group", () => {
    const company = exampleCompany();
    const items = buildAttentionList(buildTeamHierarchy(exampleAgents()), [
      row(company.ceo, "error"),
    ]);
    // No branch to name, because every branch is beneath them, but they are
    // very much in the reporting line.
    expect(items[0]?.branch).toBeNull();
    expect(items[0]?.isTop).toBe(true);
  });

  it("returns nothing when the company is healthy", () => {
    const company = exampleCompany();
    const rows = [row(company.backend, "working"), row(company.qa, "quiet")];
    expect(buildAttentionList(buildTeamHierarchy(exampleAgents()), rows)).toEqual([]);
  });
});
