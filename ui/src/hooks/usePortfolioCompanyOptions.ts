import { useMemo } from "react";
import type { Company } from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";

export interface CompanyFilterOption {
  value: string;
  label: string;
}

/** Portfolio root first, so the operator's own hub heads the list. */
function sortPortfolioRootFirst(companies: Company[]): Company[] {
  return [...companies].sort(
    (a, b) => (b.isPortfolioRoot ? 1 : 0) - (a.isPortfolioRoot ? 1 : 0),
  );
}

/**
 * Every company the Company filter should offer, regardless of what is
 * currently filtered.
 *
 * The portfolio pages used to build this list from `companies` on their own
 * response. That response is itself narrowed by the company filter, so picking
 * one company shrank the list to that one company and the operator could never
 * add a second without clearing first: a multi-select that behaved as
 * single-select. The options have to come from something the filter cannot
 * narrow.
 *
 * This is the same set the server starts from - every non-archived company -
 * and it is already in the company context, so it costs no extra request.
 */
export function usePortfolioCompanyOptions(): CompanyFilterOption[] {
  const { companies } = useCompany();

  return useMemo(
    () =>
      sortPortfolioRootFirst(companies.filter((c) => c.status !== "archived"))
        .map((c) => ({ value: c.id, label: c.name })),
    [companies],
  );
}
