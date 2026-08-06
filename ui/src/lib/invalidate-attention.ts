import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./queryKeys";

/**
 * Refresh everything that answers "what is waiting on you" for a company.
 *
 * Call this after any action that could open or close a decision: answering
 * an agent's question, deciding an approval, signing off an issue, marking
 * something read. One helper rather than a list of invalidations at each
 * call site, so a surface added later cannot be forgotten and drift out of
 * step with the rest.
 *
 * The portfolio roll-up is keyed by the HQ company, not by the company the
 * action happened in, so it is invalidated by prefix.
 */
export function invalidateAttention(queryClient: QueryClient, companyId: string | null | undefined) {
  if (!companyId) return;
  queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
  queryClient.invalidateQueries({ queryKey: ["portfolio-attention"] });
  queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) });
}
