import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { sidebarPreferencesApi } from "../api/sidebarPreferences";
import { queryKeys } from "../lib/queryKeys";

function areEqual(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function buildOrder(allIds: string[], orderedIds: string[]): string[] {
  if (allIds.length === 0) return [];
  if (orderedIds.length === 0) return [...allIds];
  const known = new Set(allIds);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of orderedIds) {
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  for (const id of allIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

type UsePortfolioNavOrderParams = {
  allIds: string[];
  userId: string | null | undefined;
};

export function usePortfolioNavOrder({ allIds, userId }: UsePortfolioNavOrderParams) {
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => queryKeys.sidebarPreferences.portfolioNavOrder(userId ?? "__anon__"),
    [userId],
  );

  const { data } = useQuery({
    queryKey,
    queryFn: () => sidebarPreferencesApi.getPortfolioNavOrder(),
    enabled: Boolean(userId),
  });

  const allIdsKey = allIds.join(" ");
  const [orderedIds, setOrderedIds] = useState<string[]>(() => buildOrder(allIds, []));

  useEffect(() => {
    const next = buildOrder(allIds, data?.orderedIds ?? []);
    setOrderedIds((current) => (areEqual(current, next) ? current : next));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allIdsKey, data?.orderedIds]);

  const mutation = useMutation({
    mutationFn: (next: string[]) =>
      sidebarPreferencesApi.updatePortfolioNavOrder({ orderedIds: next }),
    onSuccess: (preference) => {
      queryClient.setQueryData(queryKey, preference);
    },
  });

  const persistOrder = useCallback(
    (next: string[]) => {
      const filtered = buildOrder(allIds, next);
      setOrderedIds((current) => (areEqual(current, filtered) ? current : filtered));
      if (!userId) return;
      queryClient.setQueryData(queryKey, (current: { orderedIds?: string[]; updatedAt?: Date | null } | undefined) => ({
        orderedIds: filtered,
        updatedAt: current?.updatedAt ?? null,
      }));
      mutation.mutate(filtered);
    },
    [allIds, mutation, queryClient, queryKey, userId],
  );

  return { orderedIds, persistOrder };
}
