import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { toCompanyRelativePath } from "../lib/company-routes";
import {
  getRememberedPathOwnerCompanyId,
  isRememberableCompanyPath,
  readRememberedCompanyPath,
  sanitizeRememberedPathForCompany,
  writeRememberedCompanyPath,
} from "../lib/company-page-memory";
import { resolveCompanySwitchDestination } from "../lib/company-switch";
import { shouldRestoreRememberedPath } from "../lib/company-selection";
import { registerPluginRouteRoots } from "../lib/plugin-route-registry";
import { pluginsApi } from "../api/plugins";
import { queryKeys } from "../lib/queryKeys";

/**
 * Keeps plugin-route-registry.ts current with the plugin page routes that
 * are actually installed, so toCompanyRelativePath can recognize them as
 * valid company-scoped route roots (not just the compile-time-known core
 * pages). Shares its query with every other caller of listUiContributions()
 * via the same query key — this doesn't cause an extra fetch.
 */
function usePluginRouteRootsSync() {
  const { data } = useQuery({
    queryKey: queryKeys.plugins.uiContributions,
    queryFn: () => pluginsApi.listUiContributions(),
  });

  useEffect(() => {
    if (!data) return;
    const routePaths = data.flatMap((contribution) =>
      contribution.slots
        .filter((slot) => slot.type === "page" && slot.routePath)
        .map((slot) => slot.routePath!),
    );
    if (routePaths.length > 0) registerPluginRouteRoots(routePaths);
  }, [data]);
}

/**
 * Two jobs, in this order of importance.
 *
 * It keeps you on the page you were reading when you change company, which is
 * what the mockup does (docs/plans/2026-09-07-mockup-vs-app.md, difference 7)
 * and what the scope document asks for ("Changing company preserves the
 * current workspace when supported"). lib/company-switch.ts works out the
 * address and the sentence that explains any part of it that could not be
 * kept; this hook is only the wiring.
 *
 * It also still records the last page each company had open. That used to be
 * replayed automatically on every switch, which is precisely the "competing
 * implicit redirect" the scope document rules out, so nothing replays it now.
 * It is offered instead: as a link on the message a switch shows, and as a
 * row in the company rail's hover menu (hooks/useRememberedCompanyPage.ts).
 */
export function useCompanyPageMemory() {
  usePluginRouteRootsSync();
  const { companies, selectedCompanyId, selectedCompany, selectionSource } = useCompany();
  const location = useLocation();
  const navigate = useNavigate();
  const { pushToast } = useToastActions();
  const prevCompanyId = useRef<string | null>(selectedCompanyId);
  const rememberedPathOwnerCompanyId = useMemo(
    () =>
      getRememberedPathOwnerCompanyId({
        companies,
        pathname: location.pathname,
        fallbackCompanyId: prevCompanyId.current,
      }),
    [companies, location.pathname],
  );

  // Save current path for current company on every location change.
  // Uses prevCompanyId ref so we save under the correct company even
  // during the render where selectedCompanyId has already changed.
  const fullPath = location.pathname + location.search;
  useEffect(() => {
    const companyId = rememberedPathOwnerCompanyId;
    const relativePath = toCompanyRelativePath(fullPath);
    if (companyId && isRememberableCompanyPath(relativePath)) {
      writeRememberedCompanyPath(companyId, relativePath);
    }
  }, [fullPath, rememberedPathOwnerCompanyId]);

  // Move to the same page in the newly picked company.
  //
  // location.pathname is read here rather than at the time of the click, and
  // that is safe: this effect only acts on the render where the selected
  // company changed, and the address has not moved yet on that render, so it
  // still names the page you were on. The effect re-runs on later navigations
  // and does nothing, because the company has not changed by then.
  useEffect(() => {
    if (!selectedCompanyId) return;

    if (
      prevCompanyId.current !== null &&
      selectedCompanyId !== prevCompanyId.current
    ) {
      // "shortcut" (SidebarNavItem.tsx's hover-flyout click) already knows
      // exactly where it's navigating, same as "route_sync" — moving it
      // somewhere else here would silently overwrite that explicit
      // destination (this was B01's double-prefix bug: see the comment
      // above CompanySelectionSource in ../lib/company-selection.ts). That
      // is also what makes "where you left off" work: it is a shortcut, so
      // it wins.
      if (shouldRestoreRememberedPath(selectionSource) && selectedCompany) {
        const leavingCompany = companies.find((c) => c.id === prevCompanyId.current) ?? null;
        const destination = resolveCompanySwitchDestination({
          currentPath: location.pathname,
          toCompany: {
            name: selectedCompany.name,
            isPortfolioRoot: selectedCompany.isPortfolioRoot === true,
          },
          fromCompanyName: leavingCompany?.name ?? null,
        });
        navigate(`/${selectedCompany.issuePrefix}${destination.path}`, { replace: true });

        // The remembered page, offered rather than imposed. Only when it
        // would actually take you somewhere else, so the message never
        // offers you the page you are already looking at.
        const storedPath = readRememberedCompanyPath(selectedCompanyId);
        const remembered = storedPath
          ? sanitizeRememberedPathForCompany({
            path: storedPath,
            companyPrefix: selectedCompany.issuePrefix,
          })
          : null;
        const rememberedIsElsewhere = !!remembered && remembered !== destination.path;
        pushToast({
          title: destination.title,
          body: destination.body ?? undefined,
          tone: "info",
          ttlMs: 8000,
          dedupeKey: `company-switch:${selectedCompanyId}:${destination.path}`,
          action: rememberedIsElsewhere
            ? {
              label: "Go to where you left off",
              href: `/${selectedCompany.issuePrefix}${remembered}`,
            }
            : undefined,
        });
      }
    }
    prevCompanyId.current = selectedCompanyId;
  }, [
    companies,
    location.pathname,
    navigate,
    pushToast,
    selectedCompany,
    selectedCompanyId,
    selectionSource,
  ]);
}
