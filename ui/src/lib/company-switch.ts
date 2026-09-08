/**
 * Where you land when you change company.
 *
 * The rule, from docs/plans/2026-09-02-ux-control-center-scope.md ("A stable
 * scope layer"): "Changing company preserves the current workspace when
 * supported", and "Resuming a company's remembered location may remain an
 * explicit alternative, not a competing implicit redirect." The mockup asks
 * for the same thing (docs/plans/2026-09-07-mockup-vs-app.md, difference 7):
 * switching company leaves you on the page you were reading.
 *
 * What this replaces: the app used to send you to the last page you had open
 * in the company you picked, falling back to the Overview. That was a real
 * choice rather than a fault, and the remembered page is still stored and
 * still reachable (see hooks/useRememberedCompanyPage.ts and the row the
 * company rail's hover menu draws from it). It is now something you ask for
 * instead of something that happens to you.
 *
 * Three things stop this being a plain prefix swap:
 *
 * 1. A page can name one record, and that record belongs to the company you
 *    just left. Carrying /HQ/issues/HQ-12 over to Acme would ask Acme for
 *    HQ's task. The workspace is kept and the record is dropped, which is the
 *    scope document's "clear selected records" applied to the address itself.
 * 2. A page can be a form you had started filling in. The same document says
 *    never to silently retarget one, so a half-written new agent is left
 *    behind rather than quietly refiled under the new company.
 * 3. The portfolio pages add every company together and are mounted under
 *    HQ's own address prefix, so no ordinary company can open one. Each is
 *    swapped for that company's own version of the same page (Portfolio Costs
 *    becomes Costs), and where there is no such version the Overview is used.
 *
 * Every case that is not an exact keep returns a sentence saying what
 * happened, so nothing moves you without telling you.
 *
 * Search strings are dropped on purpose. They carry selections (an open
 * message, a filter built from one company's labels), and none of them is
 * worth the risk of pointing the new company at the old one's record.
 */
import {
  extractCompanyPrefixFromPath,
  isGlobalPath,
  toCompanyRelativePath,
} from "./company-routes";
import { possessive } from "./possessive";
import { companyPathForPortfolioPage, isPortfolioRoutePath } from "./scope-kind";
import { workspaceCatalogEntryForRouteRoot } from "./workspace-catalog";

/** Where a switch lands when nothing better can be worked out. */
export const COMPANY_SWITCH_FALLBACK_PATH = "/brief";

export type CompanySwitchKind =
  /** The same address, in the new company. */
  | "same_page"
  /** Same workspace, without the one record that was open in it. */
  | "record_left_behind"
  /** Same workspace, without the form that was being filled in. */
  | "form_left_behind"
  /** An all company page swapped for this company's own version of it. */
  | "portfolio_swapped"
  /** An all company page with no per company version, so the Overview. */
  | "portfolio_unavailable"
  /** Somewhere that is not a company page at all, so the Overview. */
  | "not_a_company_page";

export interface CompanySwitchDestination {
  /** Company relative; the caller adds the new company's prefix. */
  path: string;
  kind: CompanySwitchKind;
  /** Short heading for the message, always naming the company you are in. */
  title: string;
  /** The rest of the message, or null when nothing needed saying. */
  body: string | null;
}

/**
 * Addresses whose deeper segments name one record or one form.
 *
 * `keep` lists the second segments that are views of the list rather than a
 * record, so /issues/backlog and /agents/paused survive a switch while
 * /issues/HQ-12 and /agents/<one agent> do not.
 *
 * `record` is the everyday word for one of them, used in the message. null
 * means anything deeper than the root is a form or a wizard rather than a
 * saved record, so the form wording is used instead.
 */
const RECORD_ROUTE_ROOTS: Readonly<
  Record<string, { landing: string; record: string | null; keep?: string[] }>
> = {
  issues: {
    landing: "/issues",
    record: "task",
    keep: ["all", "active", "backlog", "done", "recent"],
  },
  projects: { landing: "/projects", record: "project" },
  goals: { landing: "/goals", record: "goal" },
  routines: { landing: "/routines", record: "automation" },
  approvals: { landing: "/approvals", record: "approval", keep: ["pending", "all"] },
  agents: {
    landing: "/agents/all",
    record: "agent",
    keep: ["all", "active", "paused", "error"],
  },
  assistants: { landing: "/assistants", record: "assistant" },
  "execution-workspaces": { landing: "/workspaces", record: "workspace" },
  skills: { landing: "/skills", record: "skill" },
  // Company settings open the company you are in, so /company/settings is
  // kept. Everything else under /company (an import wizard, an export in
  // progress) belongs to the company that started it.
  company: { landing: "/company/settings", record: null, keep: ["settings"] },
};

/** Second segments that mean a form was open rather than a saved record. */
const FORM_SEGMENTS = new Set(["new", "edit"]);

function segmentsOf(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

/**
 * What the app calls the page at this address, with or without a company
 * prefix on it, or null when it has no name of its own. Read from the
 * workspace catalog so a page renamed there is renamed in these messages too.
 */
export function workspaceLabelForPath(path: string): string | null {
  const root = segmentsOf(toCompanyRelativePath(path))[0];
  if (!root) return null;
  return workspaceCatalogEntryForRouteRoot(root)?.label ?? null;
}

function withoutSearch(path: string): string {
  return path.split("?")[0]?.split("#")[0] ?? "/";
}

export function resolveCompanySwitchDestination(params: {
  /** The address you are on now, with or without a company prefix. */
  currentPath: string;
  toCompany: { name: string; isPortfolioRoot: boolean };
  /** The company you are leaving, when it is known. */
  fromCompanyName?: string | null;
}): CompanySwitchDestination {
  const { toCompany } = params;
  const toName = toCompany.name;
  const title = `Now in ${toName}`;
  const fromName = params.fromCompanyName || "the company you left";
  const relative = withoutSearch(toCompanyRelativePath(params.currentPath));

  const keep = (kind: CompanySwitchKind, path: string, body: string | null) => ({
    path,
    kind,
    title,
    body,
  });

  // Instance settings, sign in, and anything else that is not a company page.
  // There is no equivalent of it inside a company, so the Overview it is.
  if (isGlobalPath(relative)) {
    return keep(
      "not_a_company_page",
      COMPANY_SWITCH_FALLBACK_PATH,
      `The page you were on is not part of a company, so this is the ${toName} Overview.`,
    );
  }

  // Nothing recognisable is left once the prefix comes off: either the
  // address was a bare company root (/HQ) or it names a page this build does
  // not know about. Carrying it over would build /ACME/HQ, which is the
  // double prefix bug B01 fixed once already.
  if (extractCompanyPrefixFromPath(relative)) {
    return keep(
      "not_a_company_page",
      COMPANY_SWITCH_FALLBACK_PATH,
      `Opened the ${toName} Overview.`,
    );
  }

  if (isPortfolioRoutePath(relative)) {
    // HQ is the one company that can open these, because they are mounted
    // under its own address prefix.
    if (toCompany.isPortfolioRoot) {
      return keep("same_page", relative, null);
    }
    const portfolioLabel = workspaceLabelForPath(relative) ?? "That page";
    const paired = companyPathForPortfolioPage(relative) ?? COMPANY_SWITCH_FALLBACK_PATH;
    const pairedLabel = workspaceLabelForPath(paired);
    if (paired === COMPANY_SWITCH_FALLBACK_PATH) {
      return keep(
        "portfolio_unavailable",
        paired,
        `${portfolioLabel} adds every company together, and ${toName} has no page of its own like it, so this is its Overview.`,
      );
    }
    return keep(
      "portfolio_swapped",
      paired,
      `${portfolioLabel} adds every company together, so this is ${possessive(toName)} own ${pairedLabel ?? "version"}.`,
    );
  }

  const segments = segmentsOf(relative);
  const root = segments[0]?.toLowerCase() ?? "";
  const deeper = segments.slice(1);
  const rule = RECORD_ROUTE_ROOTS[root];

  if (rule && deeper.length > 0) {
    const second = deeper[0]!.toLowerCase();
    const isKeptView = rule.keep?.includes(second) === true;
    if (!isKeptView) {
      const landingLabel = workspaceLabelForPath(rule.landing) ?? "the list";
      const isForm = rule.record === null || deeper.some((segment) => FORM_SEGMENTS.has(segment));
      if (isForm) {
        return keep(
          "form_left_behind",
          rule.landing,
          `Opened ${landingLabel}. What you had open was for ${fromName} and was not carried over.`,
        );
      }
      return keep(
        "record_left_behind",
        rule.landing,
        `Opened ${landingLabel}. The ${rule.record} you had open belongs to ${fromName}.`,
      );
    }
  }

  const label = workspaceLabelForPath(relative);
  return keep("same_page", relative, label ? `Kept you on ${label}.` : "Kept you on the same page.");
}
