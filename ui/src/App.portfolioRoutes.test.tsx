import { createRoutesFromElements, matchRoutes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { boardRoutes } from "./App";
import { PortfolioScopeRoute } from "./components/PortfolioScopeRoute";
import { PortfolioBrief } from "./pages/PortfolioBrief";
import { PortfolioCosts } from "./pages/PortfolioCosts";
import { PortfolioDirectives } from "./pages/PortfolioDirectives";
import { PortfolioEmail } from "./pages/PortfolioEmail";
import {
  PortfolioTeams,
  PortfolioTeamsAgents,
  PortfolioTeamsAssistants,
  PortfolioTeamsOrg,
  PortfolioTeamsRightNow,
  PortfolioTeamsTimeline,
} from "./pages/PortfolioAgents";

/**
 * Putting the all company pages behind a shell that can say "not available
 * here" must not move any of them. Every address still has to resolve to the
 * page it always resolved to, and every one of them has to be inside the
 * shell, or a company could open a page holding every company's data.
 */
const routes = createRoutesFromElements(boardRoutes());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pageAt(pathname: string): any {
  const matches = matchRoutes(routes, pathname);
  expect(matches, `no route matched ${pathname}`).not.toBeNull();
  const leaf = matches![matches!.length - 1]!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (leaf.route as any).element?.type;
}

function isInsidePortfolioShell(pathname: string): boolean {
  const matches = matchRoutes(routes, pathname) ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return matches.some((match) => (match.route as any).element?.type === PortfolioScopeRoute);
}

function isInsidePortfolioTeams(pathname: string): boolean {
  const matches = matchRoutes(routes, pathname) ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return matches.some((match) => (match.route as any).element?.type === PortfolioTeams);
}

const PORTFOLIO_PATHS = [
  "/portfolio-brief",
  "/portfolio-email",
  "/portfolio-issues",
  "/portfolio-directives",
  "/portfolio-agents",
  "/portfolio-agents/timeline",
  "/portfolio-agents/agents",
  "/portfolio-agents/org",
  "/portfolio-agents/assistants",
  "/portfolio-approvals",
  "/portfolio-activity",
  "/portfolio-routines",
  "/portfolio-calendar",
  "/portfolio-costs",
  "/portfolio-receipts",
];

describe("Portfolio addresses", () => {
  it("still opens the same page at each address", () => {
    expect(pageAt("/portfolio-brief")).toBe(PortfolioBrief);
    expect(pageAt("/portfolio-costs")).toBe(PortfolioCosts);
    expect(pageAt("/portfolio-directives")).toBe(PortfolioDirectives);
    expect(pageAt("/portfolio-email")).toBe(PortfolioEmail);
    expect(pageAt("/portfolio-agents")).toBe(PortfolioTeamsRightNow);
    expect(pageAt("/portfolio-agents/timeline")).toBe(PortfolioTeamsTimeline);
    expect(pageAt("/portfolio-agents/agents")).toBe(PortfolioTeamsAgents);
    expect(pageAt("/portfolio-agents/org")).toBe(PortfolioTeamsOrg);
    expect(pageAt("/portfolio-agents/assistants")).toBe(PortfolioTeamsAssistants);
  });

  it("keeps all five team views inside the Portfolio Teams tab shell", () => {
    for (const path of PORTFOLIO_PATHS.filter((path) => path.startsWith("/portfolio-agents"))) {
      expect(isInsidePortfolioTeams(path), path).toBe(true);
    }
  });

  it("puts every all company page behind the scope shell", () => {
    for (const path of PORTFOLIO_PATHS) {
      expect(isInsidePortfolioShell(path), path).toBe(true);
    }
  });

  it("leaves the old portfolio-dashboard link redirecting", () => {
    const matches = matchRoutes(routes, "/portfolio-dashboard") ?? [];
    const leaf = matches[matches.length - 1];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((leaf?.route as any).element?.props?.to).toBe("/portfolio-brief");
  });

  it("leaves an ordinary company page outside the shell", () => {
    expect(isInsidePortfolioShell("/costs")).toBe(false);
    expect(isInsidePortfolioShell("/brief")).toBe(false);
  });
});
