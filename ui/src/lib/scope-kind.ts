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
 * page title. Confirmed live by the operator 2026-09-02: opening Portfolio Brief
 * showed no way to tell, from the header, that the data was aggregate rather
 * than HQ's own.
 */
import type { CompanyKind } from "@paperclipai/shared";
import { isBoardPathWithoutPrefix, toCompanyRelativePath } from "./company-routes";

export type ScopeKind = "portfolio" | "hq" | "company" | "personal" | "instance";

/**
 * The first segment of a path once any company prefix is taken off it.
 *
 * A portfolio-* page is always registered inside boardRoutes() (see
 * company-routes.ts's comment on BOARD_ROUTE_ROOTS), so it normally appears as
 * the SECOND segment, after a company prefix, and that company is always HQ
 * today, but nothing here should assume that. Stripping through
 * toCompanyRelativePath first (rather than naively reading segment[0]) handles
 * both the prefixed and already-relative forms the same way.
 */
function pageRootSegment(pathname: string): string | null {
  const relative = toCompanyRelativePath(pathname);
  const root = relative.split("/").filter(Boolean)[0];
  return root ? root.toLowerCase() : null;
}

export function isPortfolioRoutePath(pathname: string): boolean {
  const root = pageRootSegment(pathname);
  if (!root || !root.startsWith("portfolio-")) return false;
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
 * under the same /HQ/... prefix). Confirmed live by the operator 2026-09-02 that
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

/**
 * Portfolio as somewhere you can go, not only somewhere you end up.
 *
 * Everything above answers "which scope is this page in". Everything below
 * answers the next question, "how do I get to a different one", which the app
 * had no answer to for Portfolio: there was no Portfolio button anywhere, so
 * the only way to reach a portfolio page was to open HQ first and then find
 * one of its pages in the menu. See difference 6 in
 * docs/plans/2026-09-07-mockup-vs-app.md.
 *
 * The awkward part, and the reason this needs written down pairs at all: the
 * portfolio pages are mounted under HQ's OWN address prefix, so
 * /HQ/portfolio-costs sits beside /HQ/costs. Moving them would break saved
 * links, so they stay where they are, and the consequence is that "go to
 * Portfolio" and "come back to HQ" are not company switches at all. Both keep
 * the same company selected and only change the page, so neither can be left
 * to the ordinary pick a company and restore its remembered page path: that
 * path does nothing when the company does not change, and HQ's own remembered
 * page can itself be a portfolio page.
 */

/**
 * The company page each portfolio page is the all company version of.
 *
 * Used when leaving Portfolio, so somebody looking at costs across every
 * company lands on HQ's own costs rather than back at the top of the menu.
 *
 * portfolio-directives is deliberately absent: a directive is written once and
 * sent to several companies, so there is no per company page it is the total
 * of. Leaving Portfolio from there falls back to the Overview.
 */
const COMPANY_PAGE_FOR_PORTFOLIO_PAGE: Readonly<Record<string, string>> = {
  "portfolio-brief": "brief",
  "portfolio-email": "email",
  "portfolio-issues": "issues",
  "portfolio-agents": "team",
  "portfolio-approvals": "approvals",
  "portfolio-routines": "routines",
  "portfolio-calendar": "calendar",
  "portfolio-receipts": "receipts",
  "portfolio-activity": "activity",
  "portfolio-costs": "costs",
};

/**
 * The portfolio page each company page has an all company version of.
 *
 * Not simply the map above turned around. Team is one page with four
 * addresses (/team, /agents/all, /org, /assistants) and all four are about who
 * is on the team, so all four lead to Portfolio Agents, while coming back from
 * Portfolio Agents lands on /team, the one of the four that opens on what
 * everyone is doing.
 *
 * A page with no all company version is not listed and is not invented here.
 * Choosing Portfolio from one of those (a single task, a project, Memories)
 * opens the Portfolio Overview instead.
 */
const PORTFOLIO_PAGE_FOR_COMPANY_PAGE: Readonly<Record<string, string>> = {
  brief: "portfolio-brief",
  dashboard: "portfolio-brief",
  email: "portfolio-email",
  issues: "portfolio-issues",
  team: "portfolio-agents",
  agents: "portfolio-agents",
  org: "portfolio-agents",
  assistants: "portfolio-agents",
  approvals: "portfolio-approvals",
  routines: "portfolio-routines",
  calendar: "portfolio-calendar",
  receipts: "portfolio-receipts",
  activity: "portfolio-activity",
  costs: "portfolio-costs",
};

/** Where Portfolio opens when the current page has no all company version. */
export const DEFAULT_PORTFOLIO_PATH = "/portfolio-brief";
/** Where leaving Portfolio lands when the portfolio page has no company version. */
export const DEFAULT_COMPANY_PATH = "/brief";

/**
 * The portfolio page to open from wherever you are now, company relative
 * (the router adds the company prefix).
 *
 * Already on a portfolio page means stay on it, so choosing Portfolio while
 * you are in it does not throw away the page you were reading.
 */
export function portfolioPathForPage(pathname: string): string {
  const root = pageRootSegment(pathname);
  if (!root) return DEFAULT_PORTFOLIO_PATH;
  if (isPortfolioRoutePath(pathname)) return `/${root}`;
  const paired = PORTFOLIO_PAGE_FOR_COMPANY_PAGE[root];
  return paired ? `/${paired}` : DEFAULT_PORTFOLIO_PATH;
}

/**
 * The company page to open when leaving Portfolio, company relative, or null
 * when the current page is not a portfolio page so there is nothing to leave.
 *
 * Callers use that null to tell the two cases apart: null means an ordinary
 * company switch, which keeps its existing behaviour untouched.
 */
export function companyPathForPortfolioPage(pathname: string): string | null {
  if (!isPortfolioRoutePath(pathname)) return null;
  const root = pageRootSegment(pathname);
  const paired = root ? COMPANY_PAGE_FOR_PORTFOLIO_PAGE[root] : undefined;
  return paired ? `/${paired}` : DEFAULT_COMPANY_PATH;
}

/**
 * Whether Portfolio is worth offering to this person at all.
 *
 * Two things have to be true. There has to be an HQ, because the portfolio
 * pages live under its address and without one they cannot be opened. And
 * there has to be at least one other company, because a total of one company
 * is not a total, it is that company. Somebody who can reach only one company
 * gets no Portfolio button and no Portfolio row in the picker, rather than a
 * button leading somewhere that repeats what they are already looking at.
 *
 * portfolioCompanyCount must already exclude HQ itself and archived companies,
 * the same filter resolveScopeLabelText documents above and every other
 * portfolio count in the app uses.
 */
export function isPortfolioScopeAvailable(params: {
  hasPortfolioRoot: boolean;
  portfolioCompanyCount: number;
}): boolean {
  return params.hasPortfolioRoot && params.portfolioCompanyCount > 0;
}

/** The scopes a person can actually pick. Instance settings is not one of them. */
export type ScopeChoiceKind = Exclude<ScopeKind, "instance">;

/**
 * One line under a scope's name in the picker.
 *
 * Reuses the explanation copy above wherever it fits, so the panel's own
 * description of the scope you are in and the picker's description of a scope
 * you could move to cannot drift apart. HQ is the one exception: its guardrail
 * sentence ends "Open Portfolio for that", which is written for somebody who
 * cannot see Portfolio, and in the picker Portfolio is the row directly above.
 */
export function resolveScopeChoiceDescription(params: {
  scopeKind: ScopeChoiceKind;
  companyName: string | null;
  portfolioCompanyCount: number;
}): string {
  const explanation = resolveScopeExplanation(params);
  switch (params.scopeKind) {
    case "portfolio":
      return explanation.meaning;
    case "hq":
      return "Its own team and work, not the all company total.";
    case "company":
    case "personal":
      return explanation.includes;
  }
}

/** What resolveScopeChoices needs from a company; a real Company fits it. */
export interface ScopeChoiceCompany {
  id: string;
  name: string;
  issuePrefix: string;
  isPortfolioRoot: boolean;
  kind: CompanyKind;
  status: string;
}

export interface ScopeChoice {
  /** Stable key: "portfolio", or the company's id. */
  id: string;
  kind: ScopeChoiceKind;
  /** null for Portfolio, which is not one company. */
  company: ScopeChoiceCompany | null;
  title: string;
  description: string;
  /** True for the one you are already in, so the picker can mark it. */
  current: boolean;
}

/**
 * Every scope the picker offers, in the order it offers them.
 *
 * Portfolio first, then HQ, then the other companies in the order they were
 * given. HQ sits below Portfolio and describes itself as its own team rather
 * than the all company total, because those two are the pair people confuse:
 * they share an address prefix, and until this existed opening HQ was the only
 * way in to Portfolio at all.
 */
export function resolveScopeChoices(params: {
  companies: ScopeChoiceCompany[];
  scopeKind: ScopeKind;
  activeCompanyId: string | null;
  portfolioCompanyCount: number;
}): ScopeChoice[] {
  const { companies, scopeKind, activeCompanyId, portfolioCompanyCount } = params;
  const openable = companies.filter((company) => company.status !== "archived");
  const hq = openable.find((company) => company.isPortfolioRoot) ?? null;
  const inPortfolio = scopeKind === "portfolio";
  // Instance settings are not a company, so no company row is the one you are
  // in while you are there, even though one is still selected underneath.
  const inCompanyScope = !inPortfolio && scopeKind !== "instance";

  const choices: ScopeChoice[] = [];

  if (isPortfolioScopeAvailable({ hasPortfolioRoot: !!hq, portfolioCompanyCount })) {
    choices.push({
      id: "portfolio",
      kind: "portfolio",
      company: null,
      title: "Portfolio",
      description: resolveScopeChoiceDescription({
        scopeKind: "portfolio",
        companyName: null,
        portfolioCompanyCount,
      }),
      current: inPortfolio,
    });
  }

  const ordered = hq ? [hq, ...openable.filter((company) => company.id !== hq.id)] : openable;
  for (const company of ordered) {
    const kind: ScopeChoiceKind = company.isPortfolioRoot
      ? "hq"
      : company.kind === "personal"
        ? "personal"
        : "company";
    choices.push({
      id: company.id,
      kind,
      company,
      title: company.name,
      description: resolveScopeChoiceDescription({
        scopeKind: kind,
        companyName: company.name,
        portfolioCompanyCount,
      }),
      // A portfolio page is mounted under HQ's prefix, so HQ is the active
      // company while you are on one. It is still not the scope you are in,
      // and marking it as such would put the tick on two rows at once.
      current: inCompanyScope && company.id === activeCompanyId,
    });
  }

  return choices;
}
