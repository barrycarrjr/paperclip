import { toCompanyRelativePath } from "./company-routes";
import { TEAM_TABS, teamTabForPath, type TeamTab } from "./team-tabs";

/**
 * Portfolio Teams mirrors the five views in a single-company Team workspace.
 * The labels and company destinations come directly from TEAM_TABS so the two
 * tab strips cannot drift apart as either workspace evolves.
 */
export interface PortfolioTeamTab {
  id: TeamTab["id"];
  label: string;
  /** Portfolio-relative destination. The router adds HQ's prefix. */
  to: string;
  /** Destination for the same view inside one company. */
  companyTo: string;
  /** Segment below /portfolio-agents. Omitted for the default view. */
  subPath?: string;
}

export const PORTFOLIO_TEAMS_ROUTE_ROOT = "portfolio-agents";

export const PORTFOLIO_TEAM_TABS: PortfolioTeamTab[] = TEAM_TABS.map((tab, index) => {
  const subPath = index === 0 ? undefined : (tab.subPath ?? tab.id);
  return {
    id: tab.id,
    label: tab.label,
    to: subPath
      ? `/${PORTFOLIO_TEAMS_ROUTE_ROOT}/${subPath}`
      : `/${PORTFOLIO_TEAMS_ROUTE_ROOT}`,
    companyTo: tab.to,
    subPath,
  };
});

export const PORTFOLIO_TEAM_DEFAULT_TAB = PORTFOLIO_TEAM_TABS[0]!;

function segmentsOf(pathname: string): string[] {
  // A bare /portfolio-agents/org is already company-relative. Feeding it
  // through toCompanyRelativePath would mistake "portfolio-agents" for a
  // company prefix because "org" is also a top-level company route.
  const rawPathname = pathname.split(/[?#]/)[0] ?? "";
  const rawSegments = rawPathname.split("/").filter(Boolean);
  const relative =
    rawSegments[0]?.toLowerCase() === PORTFOLIO_TEAMS_ROUTE_ROOT
      ? rawPathname
      : toCompanyRelativePath(pathname);
  const withoutQuery = relative.split(/[?#]/)[0] ?? "";
  return withoutQuery
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
}

/** Which Portfolio Teams tab an address belongs to. */
export function portfolioTeamTabForPath(pathname: string): PortfolioTeamTab | null {
  const segments = segmentsOf(pathname);
  if (segments[0] !== PORTFOLIO_TEAMS_ROUTE_ROOT) return null;

  const subPath = segments[1];
  if (!subPath) return PORTFOLIO_TEAM_DEFAULT_TAB;
  return PORTFOLIO_TEAM_TABS.find((tab) => tab.subPath === subPath) ?? null;
}

/** Portfolio destination for whichever single-company Team tab is open. */
export function portfolioTeamPathForCompanyPath(pathname: string): string | null {
  const companyTab = teamTabForPath(pathname);
  if (!companyTab) return null;
  return PORTFOLIO_TEAM_TABS.find((tab) => tab.id === companyTab.id)?.to ?? null;
}
