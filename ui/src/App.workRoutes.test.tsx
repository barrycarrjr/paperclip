import { createRoutesFromElements, matchRoutes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { boardRoutes } from "./App";
import { Goals } from "./pages/Goals";
import { GoalDetail } from "./pages/GoalDetail";
import { Issues } from "./pages/Issues";
import { IssueDetail } from "./pages/IssueDetail";
import { Projects } from "./pages/Projects";
import { ProjectDetail } from "./pages/ProjectDetail";
import { Routines } from "./pages/Routines";
import { RoutineDetail } from "./pages/RoutineDetail";
import { WorkLayout } from "./pages/Work";
import { WorkQueues } from "./pages/WorkQueues";

/**
 * Folding the five Work menu lines into one page must not cost anybody a
 * saved link. Every address the app had before still has to resolve to the
 * page it always resolved to, so these check the real route table rather than
 * a copy of it.
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

function isInsideWorkShell(pathname: string): boolean {
  const matches = matchRoutes(routes, pathname) ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return matches.some((match) => (match.route as any).element?.type === WorkLayout);
}

describe("Work addresses", () => {
  it("still opens the same page at each of the five old addresses", () => {
    const expected: [string, unknown][] = [
      ["/issues", Issues],
      ["/projects", Projects],
      ["/goals", Goals],
      ["/routines", Routines],
      ["/work-queues", WorkQueues],
    ];
    for (const [path, page] of expected) {
      expect(pageAt(path), path).toBe(page);
      expect(isInsideWorkShell(path), path).toBe(true);
    }
  });

  it("sends the bare /work to the first tab", () => {
    const matches = matchRoutes(routes, "/work") ?? [];
    const leaf = matches[matches.length - 1];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((leaf?.route as any).element?.props?.to).toBe("/issues");
  });
});

describe("addresses that must stay outside the Work shell", () => {
  it("opens one task's own page at /issues/<task>", () => {
    expect(pageAt("/issues/PAP-12")).toBe(IssueDetail);
    expect(isInsideWorkShell("/issues/PAP-12")).toBe(false);
  });

  it("opens one project's own page, with its own tabs, at /projects/<project>", () => {
    for (const path of [
      "/projects/p1",
      "/projects/p1/overview",
      "/projects/p1/issues",
      "/projects/p1/configuration",
      "/projects/p1/budget",
    ]) {
      expect(pageAt(path), path).toBe(ProjectDetail);
      expect(isInsideWorkShell(path), path).toBe(false);
    }
  });

  it("opens one goal's and one automation's own page", () => {
    expect(pageAt("/goals/g1")).toBe(GoalDetail);
    expect(pageAt("/routines/r1")).toBe(RoutineDetail);
    expect(isInsideWorkShell("/goals/g1")).toBe(false);
    expect(isInsideWorkShell("/routines/r1")).toBe(false);
  });

  it("keeps the old /issues filter addresses redirecting to the task list", () => {
    for (const path of [
      "/issues/all",
      "/issues/active",
      "/issues/backlog",
      "/issues/done",
      "/issues/recent",
    ]) {
      const matches = matchRoutes(routes, path) ?? [];
      const leaf = matches[matches.length - 1];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((leaf?.route as any).element?.props?.to, path).toBe("/issues");
    }
  });
});
