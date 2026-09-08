/**
 * Classifies the current page into one of the operating contexts described in
 * docs/plans/2026-09-02-ux-control-center-scope.md ("A stable scope layer").
 * This is the first piece of P1's second bullet, making Portfolio, HQ team,
 * company, and personal scope explicit rather than implied. It does not
 * cover every context that document lists ("Shared service/account" is
 * plugin-specific and doesn't reduce to a route/company pair the way these
 * do); it covers the ones a header label can be correct about today.
 *
 * The gap this closes: portfolio-* pages are mounted under HQ's own
 * :companyPrefix (so the URL and the sidebar's company menu both read "HQ"
 * even while viewing all-company aggregate data), and the page header
 * (BreadcrumbBar.tsx) never showed company/scope identity at all, only the
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
  // appears as the SECOND segment, after a company prefix, and that company is
  // always HQ today, but nothing here should assume that. Stripping through
  // toCompanyRelativePath first (rather than naively reading segment[0])
  // handles both the prefixed and already-relative forms the same way.
  const relative = toCompanyRelativePath(pathname);
  const root = relative.split("/").filter(Boolean)[0];
  if (!root || !root.toLowerCase().startsWith("portfolio-")) return false;
  // Code-reviewed 2026-09-02: a prefix check alone isn't enough. The plugin
  // manifest validator (packages/shared/src/validators/plugin.ts) only
  // rejects an EXACT match against the reserved segment list, not a prefix
  // match, so a plugin can legally register routePath "portfolio-widgets"
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

/**
 * Text for the scope button in the top bar (BreadcrumbBar.tsx), the short
 * name of the scope you are in. Separate from the page title next to it,
 * which only ever said what page you're on, never what scope (a
 * portfolio-wide page and HQ's own page look identical there, both mounted
 * under the same /HQ/... prefix). Confirmed live by Barry 2026-09-02 that
 * nothing in the header told them apart. Returns null when there's nothing to
 * show yet (e.g. no company has resolved), so callers can skip rendering the
 * button and its separator both.
 *
 * companyCount must already exclude HQ itself and archived companies, the
 * same filter every other portfolio-count display in the app uses
 * (PortfolioBrief.tsx, PortfolioCosts.tsx: `.filter(c => !c.isPortfolioRoot
 * && c.status !== "archived")`). Code-reviewed 2026-09-02: an earlier version
 * passed the raw, unfiltered list, which both overcounted against every
 * other portfolio company count in the app and mis-pluralized "1 companies".
 *
 * Lives here rather than in BreadcrumbBar.tsx (where it started) so that the
 * short name and the long explanation below it are written, read and tested
 * in one place; they have to agree with each other.
 */
export function resolveScopeLabelText(params: {
  scopeKind: ScopeKind;
  companyName: string | null;
  portfolioCompanyCount: number;
}): string | null {
  const { scopeKind, companyName, portfolioCompanyCount } = params;
  switch (scopeKind) {
    case "portfolio":
      if (portfolioCompanyCount <= 0) return "Portfolio";
      return `Portfolio · ${portfolioCompanyCount} compan${portfolioCompanyCount === 1 ? "y" : "ies"}`;
    case "instance":
      return "Instance settings";
    case "personal":
      return companyName || "Personal";
    case "hq":
    case "company":
      return companyName || null;
  }
}

/**
 * What the scope button says once you open it.
 *
 * Three plain sentences, one per question a person actually has: what am I
 * looking at, what is inside it, and what will the app refuse to do while I
 * am here. The third is not decoration, each line is the matching
 * "Guardrail" cell from the scope table in
 * docs/plans/2026-09-02-ux-control-center-scope.md, written in everyday
 * words. That table is the agreed definition of these scopes, so the copy
 * belongs next to resolveScopeKind rather than inside a component.
 *
 * The scope table has six rows. Five of them are here. The sixth, "Shared
 * service/account" (a shared phone system, or a location-level account), is
 * deliberately absent for the same reason this file's header comment gives
 * for resolveScopeKind: it is plugin-specific and does not reduce to a
 * route/company pair, so nothing in the app can tell you are in it. Writing
 * copy for a scope that can never be selected would be a promise the button
 * cannot keep.
 */
export type ScopeExplanation = {
  /** The scope's name, repeated as the panel's heading. */
  title: string;
  /** One sentence: what this scope is. */
  meaning: string;
  /** One sentence: what is inside it. */
  includes: string;
  /** One sentence: the rule that keeps this scope from borrowing another's data. */
  guardrail: string;
};

export function resolveScopeExplanation(params: {
  scopeKind: ScopeKind;
  companyName: string | null;
  portfolioCompanyCount: number;
}): ScopeExplanation {
  const { scopeKind, companyName, portfolioCompanyCount } = params;
  switch (scopeKind) {
    case "portfolio":
      return {
        title: "Portfolio",
        meaning: "All the companies you can open, added together in one view.",
        includes:
          portfolioCompanyCount > 0
            ? `Covers the ${portfolioCompanyCount} compan${portfolioCompanyCount === 1 ? "y" : "ies"} you can open.`
            : "Covers every company you can open.",
        guardrail: "Anything you start here has to name the company it is for. It never quietly goes to HQ.",
      };
    case "hq":
      return {
        title: companyName || "HQ",
        meaning: "HQ's own agents, work and records.",
        includes: "Only HQ's own work. It leaves out the other companies.",
        guardrail: "This is not the all company total. Open Portfolio for that.",
      };
    case "company":
      return {
        title: companyName || "Company workspace",
        meaning: "One company's own working area.",
        includes: "Its email, calendar, team, work and records.",
        guardrail: "Searches, records, actions and agent choices all stay inside this company.",
      };
    case "personal":
      return {
        title: companyName || "Personal",
        meaning: "Your own private space.",
        includes: "Your private to-dos and notes, which follow you from company to company.",
        guardrail: "Nothing here is shared with a company's agents unless you share it.",
      };
    case "instance":
      return {
        title: "Instance settings",
        meaning: "Settings for this whole Paperclip install.",
        includes: "Every company on it, not just the one you were last in.",
        guardrail: "A change here applies everywhere, so it is not limited to one company.",
      };
  }
}
