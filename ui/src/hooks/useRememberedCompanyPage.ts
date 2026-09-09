import { useMemo } from "react";
import type { LucideIcon } from "lucide-react";
import { History } from "lucide-react";
import {
  readRememberedCompanyPath,
  sanitizeRememberedPathForCompany,
} from "../lib/company-page-memory";
import { toCompanyRelativePath } from "../lib/company-routes";
import { workspaceCatalogEntryForRouteRoot } from "../lib/workspace-catalog";

export interface RememberedCompanyPage {
  /** Company relative; whatever renders it adds the company's prefix. */
  to: string;
  /** What that page is called, or null when it has no name of its own. */
  pageLabel: string | null;
  icon: LucideIcon;
}

/**
 * The page a company had open last time you were in it, as something you can
 * choose to go back to.
 *
 * Switching company now keeps you on the page you were reading
 * (lib/company-switch.ts), so this is no longer replayed at you. The scope
 * document allows it only on those terms: "Resuming a company's remembered
 * location may remain an explicit alternative, not a competing implicit
 * redirect." This hook is the explicit half. It is used by the company rail's
 * hover menu, and the message a switch shows offers the same address as a
 * link.
 *
 * Returns null when there is nothing worth offering: no remembered page, or
 * one that has already been reduced to the Overview because it named a record
 * belonging to a company you can no longer reach it from.
 */
export function useRememberedCompanyPage(
  company: { id: string; issuePrefix: string } | null | undefined,
  /** Pass the address you are on now to hide the row when it points there. */
  currentPath?: string,
): RememberedCompanyPage | null {
  const companyId = company?.id ?? null;
  const companyPrefix = company?.issuePrefix ?? null;

  return useMemo(() => {
    if (!companyId || !companyPrefix) return null;
    const stored = readRememberedCompanyPath(companyId);
    if (!stored) return null;

    const path = sanitizeRememberedPathForCompany({ path: stored, companyPrefix });
    if (currentPath && toCompanyRelativePath(currentPath) === path) return null;

    const root = path.split("?")[0]?.split("/").filter(Boolean)[0] ?? null;
    const entry = root ? workspaceCatalogEntryForRouteRoot(root) : null;
    return {
      to: path,
      pageLabel: entry?.label ?? null,
      icon: entry?.icon ?? History,
    };
  }, [companyId, companyPrefix, currentPath]);
}
