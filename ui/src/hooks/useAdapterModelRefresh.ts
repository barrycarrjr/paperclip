import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";

/**
 * Re-reads an adapter's model list from the provider itself (`?refresh=1`)
 * and puts the answer where every picker reads it. Invalidating the cached
 * query is not enough: that asks the server again, and the server can answer
 * from its own cache.
 */
export function useAdapterModelRefresh(companyId: string | null | undefined) {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState<ReadonlySet<string>>(() => new Set());
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});

  const refresh = useCallback(
    async (adapterType: string) => {
      if (!companyId) return;
      setRefreshing((current) => new Set(current).add(adapterType));
      setErrors(({ [adapterType]: _cleared, ...rest }) => rest);
      try {
        const models = await agentsApi.adapterModels(companyId, adapterType, { refresh: true });
        queryClient.setQueryData(queryKeys.agents.adapterModels(companyId, adapterType), models);
      } catch (error) {
        setErrors((current) => ({
          ...current,
          [adapterType]: error instanceof Error ? error.message : "Failed to refresh adapter models.",
        }));
      } finally {
        setRefreshing((current) => {
          const next = new Set(current);
          next.delete(adapterType);
          return next;
        });
      }
    },
    [companyId, queryClient],
  );

  return {
    refresh,
    isRefreshing: (adapterType: string) => refreshing.has(adapterType),
    errorFor: (adapterType: string): string | null => errors[adapterType] ?? null,
  };
}
