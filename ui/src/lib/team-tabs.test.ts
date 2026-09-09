import { describe, expect, it } from "vitest";
import {
  TEAM_DEFAULT_TAB,
  TEAM_ROUTE_ROOT,
  TEAM_TABS,
  isTeamPath,
  teamTabForPath,
} from "./team-tabs";
import { CORE_WORKSPACE_CATALOG } from "./workspace-catalog";

describe("TEAM_TABS", () => {
  it("opens on the current-work view, then the three existing pages", () => {
    expect(TEAM_TABS.map((tab) => tab.label)).toEqual([
      "Right now",
      "Agents",
      "Org chart",
      "Assistants",
    ]);
    expect(TEAM_DEFAULT_TAB.to).toBe("/team");
    expect(TEAM_DEFAULT_TAB.id).toBe(TEAM_ROUTE_ROOT);
  });

  it("points every tab except the new one at the address that page already had", () => {
    expect(TEAM_TABS.map((tab) => tab.to)).toEqual([
      "/team",
      "/agents/all",
      "/org",
      "/assistants",
    ]);
  });

  it("takes the three existing labels from the workspace catalog, not from here", () => {
    for (const routeRoot of ["agents", "org", "assistants"]) {
      const entry = CORE_WORKSPACE_CATALOG.find((item) => item.routeRoot === routeRoot);
      const tab = TEAM_TABS.find((item) => item.id === routeRoot);
      expect(entry, `catalog entry for ${routeRoot}`).toBeDefined();
      expect(tab?.label).toBe(entry?.label);
    }
  });

  it("lists Team itself in the catalog, so search and Everything offer it", () => {
    const entry = CORE_WORKSPACE_CATALOG.find((item) => item.routeRoot === TEAM_ROUTE_ROOT);
    expect(entry?.label).toBe("Team");
  });
});

describe("teamTabForPath", () => {
  it("maps each old address to its tab", () => {
    expect(teamTabForPath("/agents/all")?.id).toBe("agents");
    expect(teamTabForPath("/agents/active")?.id).toBe("agents");
    expect(teamTabForPath("/agents/paused")?.id).toBe("agents");
    expect(teamTabForPath("/agents/error")?.id).toBe("agents");
    expect(teamTabForPath("/org")?.id).toBe("org");
    expect(teamTabForPath("/assistants")?.id).toBe("assistants");
    expect(teamTabForPath("/team")?.id).toBe("team");
  });

  it("works with a company prefix in front of the address", () => {
    expect(teamTabForPath("/ACME/agents/all")?.id).toBe("agents");
    expect(teamTabForPath("/ACME/org")?.id).toBe("org");
    expect(teamTabForPath("/ACME/assistants")?.id).toBe("assistants");
    expect(teamTabForPath("/ACME/team")?.id).toBe("team");
  });

  it("still recognises a deeper page under a tab, such as one agent", () => {
    expect(teamTabForPath("/agents/mail-triage")?.id).toBe("agents");
    expect(teamTabForPath("/agents/mail-triage/runs/run-1")?.id).toBe("agents");
    expect(teamTabForPath("/assistants/alex/edit")?.id).toBe("assistants");
  });

  it("ignores a query string or hash", () => {
    expect(teamTabForPath("/org?zoom=2")?.id).toBe("org");
    expect(teamTabForPath("/assistants#top")?.id).toBe("assistants");
  });

  it("says no for addresses that are not Team", () => {
    expect(teamTabForPath("/issues")).toBeNull();
    expect(teamTabForPath("/email")).toBeNull();
    expect(teamTabForPath("/")).toBeNull();
    expect(isTeamPath("/issues")).toBe(false);
    expect(isTeamPath("/org")).toBe(true);
  });
});
