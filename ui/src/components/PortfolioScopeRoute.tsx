import { useEffect, useMemo } from "react";
import { Globe2 } from "lucide-react";
import { Outlet, useLocation } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useActiveCompanyId, useIsActiveCompanyPortfolioRoot } from "../hooks/useRouteCompany";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { WorkspaceUnavailable } from "./WorkspaceUnavailable";
import { companyPathForPortfolioPage } from "../lib/scope-kind";
import { workspaceLabelForPath } from "../lib/company-switch";
import { possessive } from "../lib/possessive";

/**
 * The gate on every all company page.
 *
 * The portfolio pages are mounted under HQ's own address prefix, so
 * /ACME/portfolio-costs is a real, matching address even though Acme is one
 * company and the page adds every company together. What used to happen there
 * was nothing at all: each page turns its own queries off unless the company
 * in the address is the portfolio root, so the page drew its headings over an
 * empty body and never said why. That is the state
 * docs/plans/2026-09-02-ux-control-center-scope.md rules out ("Unsupported
 * access shows a clear unavailable/setup/permission state").
 *
 * It is one gate around the routes rather than a check inside each of the
 * eleven pages, so a portfolio page added later is covered without anybody
 * remembering to add it.
 *
 * Switching company from a portfolio page does not usually land here: the
 * switch swaps the page for that company's own version of it and says so (see
 * lib/company-switch.ts). This is for every other way of arriving, a saved
 * link most of all.
 */
export function PortfolioScopeRoute() {
  const { companies, loading } = useCompany();
  const activeCompanyId = useActiveCompanyId();
  const isPortfolioRoot = useIsActiveCompanyPortfolioRoot();
  const location = useLocation();
  const { setBreadcrumbs } = useBreadcrumbs();

  const company = useMemo(
    () => companies.find((c) => c.id === activeCompanyId) ?? null,
    [companies, activeCompanyId],
  );
  const hqCompany = useMemo(
    () => companies.find((c) => c.isPortfolioRoot && c.status !== "archived") ?? null,
    [companies],
  );

  // Until the company list has loaded there is no honest answer, so the page
  // is left to render. Blanking it would mean HQ's own portfolio pages
  // flashed an error on every cold load.
  const answerKnown = !loading && companies.length > 0 && !!company;
  const blocked = answerKnown && !isPortfolioRoot;

  const pageLabel = workspaceLabelForPath(location.pathname) ?? "This page";

  useEffect(() => {
    if (blocked) setBreadcrumbs([{ label: pageLabel }]);
  }, [blocked, pageLabel, setBreadcrumbs]);

  if (!blocked) return <Outlet />;

  const ownPath = companyPathForPortfolioPage(location.pathname) ?? "/brief";
  const ownLabel = workspaceLabelForPath(ownPath) ?? "Overview";
  const companyName = company?.name ?? "This company";

  return (
    <WorkspaceUnavailable
      title={pageLabel}
      icon={Globe2}
      reason={`${companyName} is one company, and this page adds every company together.`}
      whatToDo={
        hqCompany
          ? `The all company pages live in ${hqCompany.name}. Open it there, or stay here for ${possessive(companyName)} own numbers.`
          : `Stay here for ${possessive(companyName)} own numbers.`
      }
      actionHref={company ? `/${company.issuePrefix}${ownPath}` : ownPath}
      actionLabel={`Open ${possessive(companyName)} ${ownLabel}`}
    />
  );
}
