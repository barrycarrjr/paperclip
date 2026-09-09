import { toCompanyRelativePath } from "./company-routes";
import { workspaceCatalogEntryForRouteRoot } from "./workspace-catalog";

/**
 * The tabs on the Team page.
 *
 * The mockup shows Team as one page that leads with what each agent is doing
 * right now, instead of three separate menu lines
 * (docs/plans/2026-09-07-mockup-vs-app.md, difference 8). The scope document
 * puts the same thing more precisely: "Team: retain org charts, instruction
 * files, skills, runs/transcripts, configuration, budgets, assistants, and
 * channels behind a current-work-first view"
 * (docs/plans/2026-09-02-ux-control-center-scope.md, "Fully equipped local
 * workspaces"). Behind, not instead of.
 *
 * So this file is only about where you click. The roster, the org chart and
 * the assistants list were not merged, rewritten or moved: each is still its
 * own page with its own controls, and each tab IS that page's existing web
 * address. /agents/all is the Agents tab, /org is the Org chart tab,
 * /assistants is the Assistants tab. Keeping the addresses is what makes a
 * saved link keep working, a tab linkable, a reload land back on the same
 * tab, and the back button step between tabs, with no extra state stored
 * anywhere.
 *
 * The one new address is /team itself, which is the only tab with new
 * content: the current-work view. It is a real page, not a redirect, which
 * is why it differs from the Work page's /work front door.
 *
 * Labels for the three existing pages are read from the workspace catalog
 * rather than typed here, so a tab cannot end up calling a destination
 * something different from the sidebar and the search box.
 */
export interface TeamTab {
  /**
   * The tab id, which is also its route root. Keeping them the same value is
   * what stops the tab and the address bar from ever disagreeing.
   */
  id: string;
  label: string;
  /** Company-relative path. The router adds the company prefix. */
  to: string;
}

/** The Team page's own route root, and the current-work tab. */
export const TEAM_ROUTE_ROOT = "team";

function catalogLabel(routeRoot: string, fallback: string): string {
  // Falls back rather than throwing if the catalog entry ever disappears,
  // for the same reason work-tabs.ts does: a missing entry is a regression
  // for a test to catch, not a reason to take the whole page down.
  return workspaceCatalogEntryForRouteRoot(routeRoot)?.label ?? fallback;
}

export const TEAM_TABS: TeamTab[] = [
  { id: TEAM_ROUTE_ROOT, label: "Right now", to: `/${TEAM_ROUTE_ROOT}` },
  // /agents/all rather than /agents: /agents is a redirect to it, and
  // pointing the tab at the redirect would put an extra history entry
  // between the tabs and break the back button.
  { id: "agents", label: catalogLabel("agents", "Agents"), to: "/agents/all" },
  { id: "org", label: catalogLabel("org", "Org chart"), to: "/org" },
  { id: "assistants", label: catalogLabel("assistants", "Assistants"), to: "/assistants" },
];

/** Where the Team menu entry lands: the current-work view. */
export const TEAM_DEFAULT_TAB: TeamTab = TEAM_TABS[0]!;

function routeRootOf(pathname: string): string | null {
  const relative = toCompanyRelativePath(pathname);
  const withoutQuery = relative.split(/[?#]/)[0] ?? "";
  const segment = withoutQuery.split("/").filter(Boolean)[0];
  return segment ? segment.toLowerCase() : null;
}

/**
 * Which tab an address belongs to, or null if it is not a Team address.
 *
 * Works with or without the company prefix, and on a tab's deeper pages too
 * (one agent, one assistant's editor), so anything that needs to know "is
 * this Team" gets the same answer everywhere.
 */
export function teamTabForPath(pathname: string): TeamTab | null {
  const root = routeRootOf(pathname);
  if (!root) return null;
  return TEAM_TABS.find((tab) => tab.id === root) ?? null;
}

/** Whether an address is anywhere in Team. */
export function isTeamPath(pathname: string): boolean {
  return teamTabForPath(pathname) !== null;
}
