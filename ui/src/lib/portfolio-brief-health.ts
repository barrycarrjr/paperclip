import type { Agent, Company, DashboardSummary } from "@paperclipai/shared";
import type { BriefErroredAgent } from "./brief-health";
import { agentUrl } from "./utils";

/**
 * The companies the Portfolio Brief covers: every company but HQ itself and
 * the archived ones. The totals and the named agents below only ever see this
 * list, so HQ's own agents are never named in a count that leaves them out.
 */
export function portfolioBriefCompanies<T extends Pick<Company, "isPortfolioRoot" | "status">>(
  companies: T[],
): T[] {
  return companies.filter((company) => !company.isPortfolioRoot && company.status !== "archived");
}

export interface PortfolioBriefTotals {
  pendingApprovals: number;
  errors: number;
  runningAgents: number;
  monthSpendCents: number;
  activeIncidents: number;
  blockedTasks: number;
}

/** The hero numbers, summed across the companies the Brief covers. */
export function portfolioBriefTotals(
  companies: Pick<Company, "id">[],
  summariesByCompanyId: ReadonlyMap<string, DashboardSummary>,
): PortfolioBriefTotals {
  const totals: PortfolioBriefTotals = {
    pendingApprovals: 0,
    errors: 0,
    runningAgents: 0,
    monthSpendCents: 0,
    activeIncidents: 0,
    blockedTasks: 0,
  };
  for (const company of companies) {
    const s = summariesByCompanyId.get(company.id);
    if (!s) continue;
    // Already counts every pending approval, budget overrides included, so
    // budgets.pendingApprovals is not added or each override counts twice.
    totals.pendingApprovals += s.pendingApprovals ?? 0;
    totals.errors += s.agents?.error ?? 0;
    totals.runningAgents += s.agents?.running ?? 0;
    totals.monthSpendCents += s.costs?.monthSpendCents ?? 0;
    totals.activeIncidents += s.budgets?.activeIncidents ?? 0;
    totals.blockedTasks += s.tasks?.blocked ?? 0;
  }
  return totals;
}

/**
 * Agents in error across the portfolio, each linking to its page inside its
 * own company (the Brief sits under HQ, so the link carries the prefix).
 */
export function portfolioErroredAgents(
  companies: Pick<Company, "id" | "name" | "issuePrefix">[],
  agentsByCompany: ReadonlyMap<string, Pick<Agent, "id" | "name" | "status" | "urlKey">[]>,
): BriefErroredAgent[] {
  return companies.flatMap((company) =>
    (agentsByCompany.get(company.id) ?? [])
      .filter((agent) => agent.status === "error")
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        href: `/${company.issuePrefix}${agentUrl(agent)}`,
        title: `${agent.name} in ${company.name}`,
      })),
  );
}
