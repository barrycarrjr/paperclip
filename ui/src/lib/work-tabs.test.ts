import { describe, expect, it } from "vitest";
import {
  WORK_DEFAULT_TAB,
  WORK_ROUTE_ROOT,
  WORK_TABS,
  isWorkPath,
  workTabForPath,
} from "./work-tabs";
import { isBoardPathWithoutPrefix } from "./company-routes";
import { workspaceCatalogEntryForRouteRoot } from "./workspace-catalog";

describe("WORK_TABS", () => {
  it("lists the tabs the mockup shows, in the mockup's order", () => {
    expect(WORK_TABS.map((tab) => tab.label)).toEqual([
      "Tasks",
      "Projects",
      "Goals",
      "Automations",
      "Intake queues",
    ]);
  });

  it("calls each tab whatever the rest of the app calls it", () => {
    // The labels are read from the workspace catalog rather than typed in, so
    // a tab cannot end up saying a different word from the sidebar, the search
    // box and the page's own heading. This is the check that the reading
    // actually happened and did not quietly fall back to the route name.
    for (const tab of WORK_TABS) {
      expect(workspaceCatalogEntryForRouteRoot(tab.id)?.label, tab.id).toBe(tab.label);
    }
  });

  it("uses the addresses the app already had", () => {
    expect(WORK_TABS.map((tab) => tab.to)).toEqual([
      "/issues",
      "/projects",
      "/goals",
      "/routines",
      "/work-queues",
    ]);
  });

  it("points every tab at a real registered page", () => {
    for (const tab of WORK_TABS) {
      expect(isBoardPathWithoutPrefix(tab.to), tab.id).toBe(true);
    }
    expect(isBoardPathWithoutPrefix(`/${WORK_ROUTE_ROOT}`)).toBe(true);
  });

  it("opens on Tasks", () => {
    expect(WORK_DEFAULT_TAB.to).toBe("/issues");
  });
});

describe("workTabForPath", () => {
  it("puts every old address on its own tab, prefixed or not", () => {
    // This is the promise the whole design rests on: the address bar is the
    // tab, so a link somebody saved before any of this existed still opens the
    // same page and simply arrives with the right tab selected.
    const cases: [string, string][] = [
      ["/issues", "issues"],
      ["/PAP/issues", "issues"],
      ["/projects", "projects"],
      ["/PAP/projects", "projects"],
      ["/goals", "goals"],
      ["/PAP/goals", "goals"],
      ["/routines", "routines"],
      ["/PAP/routines", "routines"],
      ["/work-queues", "work-queues"],
      ["/PAP/work-queues", "work-queues"],
    ];
    for (const [pathname, expected] of cases) {
      expect(workTabForPath(pathname)?.id, pathname).toBe(expected);
    }
  });

  it("still knows the tab on a deeper page inside it", () => {
    expect(workTabForPath("/PAP/issues/PAP-12")?.id).toBe("issues");
    expect(workTabForPath("/PAP/projects/abc/budget")?.id).toBe("projects");
    expect(workTabForPath("/PAP/goals/goal-1")?.id).toBe("goals");
  });

  it("ignores anything after the path", () => {
    expect(workTabForPath("/PAP/issues?q=hello")?.id).toBe("issues");
    expect(workTabForPath("/PAP/projects#top")?.id).toBe("projects");
  });

  it("returns nothing for a page that is not part of Work", () => {
    for (const pathname of ["/PAP/calendar", "/PAP/email", "/PAP/memories", "/", "/PAP/work"]) {
      expect(workTabForPath(pathname), pathname).toBeNull();
    }
  });
});

describe("isWorkPath", () => {
  it("covers the front door and every tab", () => {
    for (const pathname of [
      "/work",
      "/PAP/work",
      "/PAP/issues",
      "/PAP/projects",
      "/PAP/goals",
      "/PAP/routines",
      "/PAP/work-queues",
      "/PAP/issues/PAP-12",
    ]) {
      expect(isWorkPath(pathname), pathname).toBe(true);
    }
  });

  it("leaves everything else alone", () => {
    for (const pathname of ["/PAP/calendar", "/PAP/brief", "/PAP/memories", "/instance/settings"]) {
      expect(isWorkPath(pathname), pathname).toBe(false);
    }
  });
});
