import { useMemo } from "react";
import { useParams } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";

/**
 * The company the URL says this page is for.
 *
 * The company selection in CompanyContext is synced from the route by an effect
 * in Layout, and an effect runs AFTER the render that triggered it. So on the
 * first render following a cross-company navigation, `selectedCompanyId` still
 * holds the PREVIOUS company while the URL already says the new one. Anything
 * that fetches during that render fetches for the wrong company.
 *
 * Usually that is invisible: the request succeeds and is replaced a moment
 * later. It is not invisible where the company is an authorisation boundary.
 * On the Email page it made every cross-company visit fail: a mailbox is scoped
 * to exactly one company, so asking for `ib-barry` while the context still said
 * HQ was rejected outright. Measured on a live instance across two days, 58
 * such requests failed, every one of them carrying a company the mailbox did
 * not belong to and every one of them the first request after a navigation.
 *
 * Reading the route directly is synchronous, so the very first render already
 * has the right answer. Falls back to the context selection for pages that are
 * not under a company prefix.
 */
export function resolveRouteCompanyId(input: {
  companyPrefix: string | undefined;
  companies: { id: string; issuePrefix: string }[];
}): string | null {
  if (!input.companyPrefix) return null;
  const wanted = input.companyPrefix.toUpperCase();
  return input.companies.find((c) => c.issuePrefix.toUpperCase() === wanted)?.id ?? null;
}

/**
 * The company this page is for: the URL's, falling back to the current
 * selection. Prefer this over `useCompany().selectedCompanyId` anywhere a
 * company-scoped request is made from a page that lives under `/:companyPrefix`.
 */
export function useActiveCompanyId(): string | null {
  const { companyPrefix } = useParams<{ companyPrefix: string }>();
  const { companies, selectedCompanyId } = useCompany();

  return useMemo(
    () => resolveRouteCompanyId({ companyPrefix, companies }) ?? selectedCompanyId,
    [companyPrefix, companies, selectedCompanyId],
  );
}
