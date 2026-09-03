import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { toCompanyRelativePath } from "../lib/company-routes";
import {
  getRememberedPathOwnerCompanyId,
  isRememberableCompanyPath,
  sanitizeRememberedPathForCompany,
} from "../lib/company-page-memory";
import { shouldRestoreRememberedPath } from "../lib/company-selection";
import { registerPluginRouteRoots } from "../lib/plugin-route-registry";
import { pluginsApi } from "../api/plugins";
import { queryKeys } from "../lib/queryKeys";

const STORAGE_KEY = "paperclip.companyPaths";

function getCompanyPaths(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return {};
}

function saveCompanyPath(companyId: string, path: string) {
  const paths = getCompanyPaths();
  paths[companyId] = path;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(paths));
}

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
 * Remembers the last visited page per company and navigates to it on company switch.
 * Falls back to /dashboard if no page was previously visited for a company.
 */
export function useCompanyPageMemory() {
  usePluginRouteRootsSync();
  const { companies, selectedCompanyId, selectedCompany, selectionSource } = useCompany();
  const location = useLocation();
  const navigate = useNavigate();
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
      saveCompanyPath(companyId, relativePath);
    }
  }, [fullPath, rememberedPathOwnerCompanyId]);

  // Navigate to saved path when company changes
  useEffect(() => {
    if (!selectedCompanyId) return;

    if (
      prevCompanyId.current !== null &&
      selectedCompanyId !== prevCompanyId.current
    ) {
      // "shortcut" (SidebarNavItem.tsx's hover-flyout click) already knows
      // exactly where it's navigating, same as "route_sync" — restoring a
      // remembered path here would silently overwrite that explicit
      // destination (this was B01's double-prefix bug: see the comment
      // above CompanySelectionSource in ../lib/company-selection.ts).
      if (shouldRestoreRememberedPath(selectionSource) && selectedCompany) {
        const paths = getCompanyPaths();
        const targetPath = sanitizeRememberedPathForCompany({
          path: paths[selectedCompanyId],
          companyPrefix: selectedCompany.issuePrefix,
        });
        navigate(`/${selectedCompany.issuePrefix}${targetPath}`, { replace: true });
      }
    }
    prevCompanyId.current = selectedCompanyId;
  }, [selectedCompany, selectedCompanyId, selectionSource, navigate]);
}
