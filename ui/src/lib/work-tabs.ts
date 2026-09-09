import { toCompanyRelativePath } from "./company-routes";
import { workspaceCatalogEntryForRouteRoot } from "./workspace-catalog";

/**
 * The tabs on the Work page.
 *
 * The mockup shows Work as one page with tabs instead of five separate menu
 * lines (docs/plans/2026-09-07-mockup-vs-app.md, difference 3). This file is
 * only about where you click. Each tab is still its own page, with its own
 * lifecycle, its own controls and its own web address, which is what the scope
 * document means by "tasks are not queues or routines. Keep their separate
 * lifecycles, deep controls, and links"
 * (docs/plans/2026-09-02-ux-control-center-scope.md, "Fully equipped local
 * workspaces").
 *
 * The address bar is the tab. A tab IS one of the five addresses the app
 * already had, so nothing was invented and nothing was redirected: /issues is
 * the Tasks tab, /projects is the Projects tab, and so on. That choice is what
 * makes a saved link keep working, a tab linkable, a reload land back on the
 * same tab, and the browser's back button step between tabs, all without a
 * single line of extra state.
 *
 * Order follows the mockup. Labels are read from the workspace catalog rather
 * than typed here, so the tab cannot end up calling a destination something
 * different from the sidebar, the search box and the page's own heading. That
 * is the same rule the catalog states for itself.
 *
 * Two things the mockup groups here are deliberately left out, and both are
 * written up in the report rather than being silent omissions: Broadcasts
 * (the app's nearest page is Portfolio Directives, which is portfolio scope
 * and exists only in HQ) and Memories (the mockup files it under Knowledge,
 * not Work).
 */
export interface WorkTab {
  /**
   * The tab id, which is also its route root. Keeping them the same value is
   * what stops the tab and the address bar from ever disagreeing.
   */
  id: string;
  label: string;
  /** Company-relative path. The router adds the company prefix. */
  to: string;
}

const WORK_TAB_ROUTE_ROOTS = [
  "issues",
  "projects",
  "goals",
  "routines",
  "work-queues",
] as const;

/** The Work page's own front door, which sends you to the first tab. */
export const WORK_ROUTE_ROOT = "work";

export const WORK_TABS: WorkTab[] = WORK_TAB_ROUTE_ROOTS.map((routeRoot) => ({
  id: routeRoot,
  // Falls back to the route root rather than throwing if the catalog entry
  // ever disappears, for the same reason MobileBottomNav.tsx does: a missing
  // entry is a regression for a test to catch, not a reason to take the whole
  // page down. work-tabs.test.ts asserts the real labels.
  label: workspaceCatalogEntryForRouteRoot(routeRoot)?.label ?? routeRoot,
  to: `/${routeRoot}`,
}));

/** Where /work sends you: the first tab. */
export const WORK_DEFAULT_TAB: WorkTab = WORK_TABS[0]!;

function routeRootOf(pathname: string): string | null {
  const relative = toCompanyRelativePath(pathname);
  const withoutQuery = relative.split(/[?#]/)[0] ?? "";
  const segment = withoutQuery.split("/").filter(Boolean)[0];
  return segment ? segment.toLowerCase() : null;
}

/**
 * Which tab an address belongs to, or null if it is not a Work address.
 *
 * Works with or without the company prefix, and on a tab's deeper pages too
 * (a single task, a single project), so anything that needs to know "is this
 * Work" gets the same answer everywhere.
 */
export function workTabForPath(pathname: string): WorkTab | null {
  const root = routeRootOf(pathname);
  if (!root) return null;
  return WORK_TABS.find((tab) => tab.id === root) ?? null;
}

/** Whether an address is anywhere in Work, including /work itself. */
export function isWorkPath(pathname: string): boolean {
  const root = routeRootOf(pathname);
  if (!root) return false;
  return root === WORK_ROUTE_ROOT || WORK_TABS.some((tab) => tab.id === root);
}
