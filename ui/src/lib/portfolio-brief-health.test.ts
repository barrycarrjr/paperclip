import { describe, expect, it } from "vitest";
import type { Agent, Company, DashboardSummary } from "@paperclipai/shared";
import {
  portfolioBriefCompanies,
  portfolioBriefTotals,
  portfolioErroredAgents,
} from "./portfolio-brief-health";

type TestCompany = Pick<Company, "id" | "name" | "issuePrefix" | "isPortfolioRoot" | "status">;
type TestAgent = Pick<Agent, "id" | "name" | "status" | "urlKey">;

function company(id: string, overrides: Partial<TestCompany> = {}): TestCompany {
  return {
    id,
    name: `Company ${id}`,
    issuePrefix: id.toUpperCase(),
    isPortfolioRoot: false,
    status: "active",
    ...overrides,
  };
}

function summary(
  companyId: string,
  overrides: {
    agentErrors?: number;
    running?: number;
    blocked?: number;
    pendingApprovals?: number;
    budgetApprovals?: number;
    incidents?: number;
    spend?: number;
  } = {},
): DashboardSummary {
  return {
    companyId,
    agents: { active: 1, running: overrides.running ?? 0, paused: 0, error: overrides.agentErrors ?? 0 },
    tasks: { open: 0, inProgress: 0, blocked: overrides.blocked ?? 0, done: 0 },
    costs: { monthSpendCents: overrides.spend ?? 0, monthBudgetCents: 0, monthUtilizationPercent: 0 },
    pendingApprovals: overrides.pendingApprovals ?? 0,
    budgets: {
      activeIncidents: overrides.incidents ?? 0,
      pendingApprovals: overrides.budgetApprovals ?? 0,
      pausedAgents: 0,
      pausedProjects: 0,
    },
    runActivity: [],
  };
}

function agent(id: string, name: string, status: TestAgent["status"]): TestAgent {
  return { id, name, status, urlKey: name.toLowerCase() };
}

const hq = company("hq", { isPortfolioRoot: true });
const alpha = company("alp");
const beta = company("bet");
const archived = company("old", { status: "archived" });
const all = [hq, alpha, archived, beta];

describe("portfolioBriefCompanies", () => {
  it("leaves out HQ itself and archived companies", () => {
    expect(portfolioBriefCompanies(all).map((c) => c.id)).toEqual(["alp", "bet"]);
  });
});

describe("portfolioBriefTotals", () => {
  const summaries = new Map<string, DashboardSummary>([
    ["hq", summary("hq", { agentErrors: 5, blocked: 50, pendingApprovals: 7 })],
    ["alp", summary("alp", { agentErrors: 1, blocked: 9, running: 2, spend: 150, incidents: 1 })],
    ["bet", summary("bet", { blocked: 3, running: 1, spend: 50, pendingApprovals: 2 })],
    ["old", summary("old", { agentErrors: 4, blocked: 20, pendingApprovals: 3 })],
  ]);

  it("sums blocked tasks, errors and the rest across the companies it covers", () => {
    expect(portfolioBriefTotals(portfolioBriefCompanies(all), summaries)).toEqual({
      pendingApprovals: 2,
      errors: 1,
      runningAgents: 3,
      monthSpendCents: 200,
      activeIncidents: 1,
      blockedTasks: 12,
    });
  });

  it("skips a company whose summary has not loaded", () => {
    const totals = portfolioBriefTotals([alpha, company("new")], summaries);
    expect(totals.blockedTasks).toBe(9);
  });

  // One hard stop makes one budget override approval. The company summary's
  // pendingApprovals already counts it, and budgets.pendingApprovals counts
  // the same approval again, so only the first is added.
  it("counts a pending budget override once", () => {
    const withOverride = new Map([
      ["alp", summary("alp", { incidents: 1, pendingApprovals: 1, budgetApprovals: 1 })],
    ]);
    expect(portfolioBriefTotals([alpha], withOverride).pendingApprovals).toBe(1);
  });
});

describe("portfolioErroredAgents", () => {
  const agentsByCompany = new Map<string, TestAgent[]>([
    ["hq", [agent("a-hq", "Chief", "error")]],
    ["alp", [agent("a-1", "Scout", "error"), agent("a-2", "Writer", "idle")]],
    ["bet", [agent("a-3", "Clerk", "error")]],
    ["old", [agent("a-4", "Ghost", "error")]],
  ]);

  it("names agents in error with links inside their own company", () => {
    expect(portfolioErroredAgents(portfolioBriefCompanies(all), agentsByCompany)).toEqual([
      { id: "a-1", name: "Scout", href: "/ALP/agents/scout", title: "Scout in Company alp" },
      { id: "a-3", name: "Clerk", href: "/BET/agents/clerk", title: "Clerk in Company bet" },
    ]);
  });

  it("names nobody when no agent is in error", () => {
    expect(portfolioErroredAgents([alpha], new Map([["alp", [agent("a-2", "Writer", "idle")]]]))).toEqual([]);
  });
});
