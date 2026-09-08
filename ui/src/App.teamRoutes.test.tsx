import { createRoutesFromElements, matchRoutes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { boardRoutes } from "./App";
import { Agents } from "./pages/Agents";
import { AgentDetail } from "./pages/AgentDetail";
import { AssistantsList } from "./pages/AssistantsList";
import { AssistantWizard } from "./pages/AssistantWizard";
import { NewAgent } from "./pages/NewAgent";
import { OrgChart } from "./pages/OrgChart";
import { Team, TeamLayout } from "./pages/Team";

/**
 * Folding the three Team menu lines into one page must not cost anybody a
 * saved link. Every address the app had before still has to resolve to the
 * page it always resolved to, so these check the real route table rather
 * than a copy of it.
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

function isInsideTeamShell(pathname: string): boolean {
  const matches = matchRoutes(routes, pathname) ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return matches.some((match) => (match.route as any).element?.type === TeamLayout);
}

describe("Team addresses", () => {
  it("opens the current-work page at /team", () => {
    expect(pageAt("/team")).toBe(Team);
    expect(isInsideTeamShell("/team")).toBe(true);
  });

  it("still opens the agent roster at every /agents filter address", () => {
    for (const path of ["/agents/all", "/agents/active", "/agents/paused", "/agents/error"]) {
      expect(pageAt(path), path).toBe(Agents);
      expect(isInsideTeamShell(path), path).toBe(true);
    }
  });

  it("still opens the org chart at /org", () => {
    expect(pageAt("/org")).toBe(OrgChart);
    expect(isInsideTeamShell("/org")).toBe(true);
  });

  it("still opens the assistants list at /assistants", () => {
    expect(pageAt("/assistants")).toBe(AssistantsList);
    expect(isInsideTeamShell("/assistants")).toBe(true);
  });
});

describe("addresses that must stay outside the Team shell", () => {
  it("opens one agent's own page, with its own tabs, at /agents/<agent>", () => {
    expect(pageAt("/agents/mail-triage")).toBe(AgentDetail);
    expect(pageAt("/agents/mail-triage/instructions")).toBe(AgentDetail);
    expect(pageAt("/agents/mail-triage/runs/run-1")).toBe(AgentDetail);
    expect(isInsideTeamShell("/agents/mail-triage")).toBe(false);
  });

  it("keeps the agent and assistant builders as pages of their own", () => {
    expect(pageAt("/agents/new")).toBe(NewAgent);
    expect(pageAt("/assistants/new")).toBe(AssistantWizard);
    expect(pageAt("/assistants/alex/edit")).toBe(AssistantWizard);
    expect(isInsideTeamShell("/agents/new")).toBe(false);
    expect(isInsideTeamShell("/assistants/new")).toBe(false);
  });

  it("still redirects the bare /agents to the roster", () => {
    const matches = matchRoutes(routes, "/agents") ?? [];
    const leaf = matches[matches.length - 1];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((leaf?.route as any).element?.props?.to).toBe("/agents/all");
  });
});
