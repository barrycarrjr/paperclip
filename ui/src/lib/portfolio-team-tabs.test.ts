import { describe, expect, it } from "vitest";
import { TEAM_TABS } from "./team-tabs";
import {
  PORTFOLIO_TEAM_TABS,
  portfolioTeamPathForCompanyPath,
  portfolioTeamTabForPath,
} from "./portfolio-team-tabs";

describe("Portfolio Teams tabs", () => {
  it("mirrors every company Team tab in the same order", () => {
    expect(PORTFOLIO_TEAM_TABS.map((tab) => tab.label)).toEqual(
      TEAM_TABS.map((tab) => tab.label),
    );
    expect(PORTFOLIO_TEAM_TABS.map((tab) => tab.companyTo)).toEqual(
      TEAM_TABS.map((tab) => tab.to),
    );
  });

  it("recognizes prefixed and company-relative portfolio addresses", () => {
    expect(portfolioTeamTabForPath("/portfolio-agents")?.label).toBe("Right now");
    expect(portfolioTeamTabForPath("/HQ/portfolio-agents/timeline")?.label).toBe("Timeline");
    expect(portfolioTeamTabForPath("/HQ/portfolio-agents/agents")?.label).toBe("Agents");
    expect(portfolioTeamTabForPath("/portfolio-agents/org")?.label).toBe("Org chart");
    expect(portfolioTeamTabForPath("/portfolio-agents/assistants")?.label).toBe("Assistants");
  });

  it("maps each company Team address to its matching portfolio tab", () => {
    expect(portfolioTeamPathForCompanyPath("/ACM/team")).toBe("/portfolio-agents");
    expect(portfolioTeamPathForCompanyPath("/ACM/team/timeline")).toBe(
      "/portfolio-agents/timeline",
    );
    expect(portfolioTeamPathForCompanyPath("/ACM/agents/active")).toBe(
      "/portfolio-agents/agents",
    );
    expect(portfolioTeamPathForCompanyPath("/ACM/org")).toBe("/portfolio-agents/org");
    expect(portfolioTeamPathForCompanyPath("/ACM/assistants/agent-1/edit")).toBe(
      "/portfolio-agents/assistants",
    );
  });
});
