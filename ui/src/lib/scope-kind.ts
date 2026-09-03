/**
 * Classifies the current page into one of the operating contexts described in
 * docs/plans/2026-09-02-ux-control-center-scope.md ("A stable scope layer").
 * This is the first piece of P1's second bullet — making Portfolio, HQ team,
 * company, and personal scope explicit rather than implied. It does not
 * cover every context that document lists ("Shared service/account" is
 * plugin-specific and doesn't reduce to a route/company pair the way these
 * do); it covers the ones a header label can be correct about today.
 *
 * The gap this closes: portfolio-* pages are mounted under HQ's own
 * :companyPrefix (so the URL and the sidebar's company menu both read "HQ"
 * even while viewing all-company aggregate data), and the page header
 * (BreadcrumbBar.tsx) never showed company/scope identity at all — only the
 * page title. Confirmed live by Barry 2026-09-02: opening Portfolio Brief
 * showed no way to tell, from the header, that the data was aggregate rather
 * than HQ's own.
 */
import type { CompanyKind } from "@paperclipai/shared";
import { isBoardPathWithoutPrefix, toCompanyRelativePath } from "./company-routes";

export type ScopeKind = "portfolio" | "hq" | "company" | "personal" | "instance";

export function isPortfolioRoutePath(pathname: string): boolean {
  // A portfolio-* page is always registered inside boardRoutes() (see
  // company-routes.ts's comment on BOARD_ROUTE_ROOTS), so it normally
  // appears as the SECOND segment, after a company prefix — that company is
  // always HQ today, but nothing here should assume that. Stripping through
  // toCompanyRelativePath first (rather than naively reading segment[0])
  // handles both the prefixed and already-relative forms the same way.
  const relative = toCompanyRelativePath(pathname);
  const root = relative.split("/").filter(Boolean)[0];
  if (!root || !root.toLowerCase().startsWith("portfolio-")) return false;
  // Code-reviewed 2026-09-02: a prefix check alone isn't enough. The plugin
  // manifest validator (packages/shared/src/validators/plugin.ts) only
  // rejects an EXACT match against the reserved segment list, not a prefix
  // match — so a plugin can legally register routePath "portfolio-widgets"
  // and pass validation. Confirming against isBoardPathWithoutPrefix (the
  // same reserved list) excludes that case: only the real, finite set of
  // core portfolio-* pages counts as portfolio scope, not anything a plugin
  // merely names similarly.
  return isBoardPathWithoutPrefix(`/${root}`);
}

export function isInstanceSettingsPath(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return lower === "/instance" || lower.startsWith("/instance/");
}

export function resolveScopeKind(params: {
  pathname: string;
  selectedCompany: { isPortfolioRoot: boolean; kind: CompanyKind } | null;
}): ScopeKind {
  const { pathname, selectedCompany } = params;

  if (isInstanceSettingsPath(pathname)) return "instance";
  if (isPortfolioRoutePath(pathname)) return "portfolio";
  if (selectedCompany?.kind === "personal") return "personal";
  if (selectedCompany?.isPortfolioRoot) return "hq";
  return "company";
}
