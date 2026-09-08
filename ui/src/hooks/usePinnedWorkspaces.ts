import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { sidebarPreferencesApi } from "../api/sidebarPreferences";
import { queryKeys } from "../lib/queryKeys";
import { useCurrentUserId } from "./useCurrentUserId";

/**
 * The workspaces this person keeps to hand.
 *
 * "Pinned tools" in the scope document's primary navigation, and the pinning
 * half of what the Everything page is for. A pin is a fact about the person,
 * not the company — Phone is a tool you use, and having to pin it again in
 * every company is the sort of repeated setup this project exists to remove.
 * A pinned workspace a given company cannot open is simply not shown there,
 * which is the sidebar's job rather than this hook's.
 *
 * Ids are core catalog ids ("email") or plugin route paths ("notepad"). Both
 * are slugs, so one list holds both and the order is the person's own.
 */
export function usePinnedWorkspaces() {
  const userId = useCurrentUserId();
  const queryClient = useQueryClient();
  // A signed-out or local-implicit session has no stable owner to store
  // against, so pinning is simply unavailable rather than stored somewhere
  // that will not come back.
  const enabled = Boolean(userId);
  const queryKey = queryKeys.sidebarPreferences.pinnedWorkspaces(userId ?? "__anonymous__");

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () => sidebarPreferencesApi.getPinnedWorkspaces(),
    enabled,
  });

  const pinned = useMemo(() => data?.orderedIds ?? [], [data?.orderedIds]);
  const pinnedSet = useMemo(() => new Set(pinned), [pinned]);

  const mutation = useMutation({
    mutationFn: (orderedIds: string[]) =>
      sidebarPreferencesApi.updatePinnedWorkspaces({ orderedIds }),
    // Optimistic, because a pin toggle that waits for a round trip feels
    // broken. The rollback puts the previous list back if the write fails,
    // rather than leaving the star showing a state the server never accepted.
    onMutate: async (orderedIds) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData(queryKey);
      queryClient.setQueryData(queryKey, { orderedIds, updatedAt: null });
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous !== undefined) queryClient.setQueryData(queryKey, context.previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const toggle = useCallback(
    (id: string) => {
      if (!enabled) return;
      // New pins go on the end, so pinning something does not reshuffle what
      // is already there.
      const next = pinnedSet.has(id) ? pinned.filter((entry) => entry !== id) : [...pinned, id];
      mutation.mutate(next);
    },
    [enabled, mutation, pinned, pinnedSet],
  );

  // Save a whole list in one write. Used for seeding HQ's starting pins, where
  // eleven separate toggle calls would each race the others and fire eleven
  // round trips. Resolves when the server has accepted it and rejects if it
  // has not, so a caller can wait for the real outcome rather than guess.
  const replaceAll = useCallback(
    async (orderedIds: string[]) => {
      if (!enabled) return;
      await mutation.mutateAsync(orderedIds);
    },
    [enabled, mutation],
  );

  return {
    pinned,
    isPinned: useCallback((id: string) => pinnedSet.has(id), [pinnedSet]),
    toggle,
    replaceAll,
    /** False when there is no signed-in user to store a pin against. */
    canPin: enabled,
    /** The person the pins belong to, or null when nobody can be resolved. */
    ownerId: userId,
    isLoading: enabled && isLoading,
    /**
     * True only once the saved list has actually arrived. `!isLoading` is not
     * the same thing: a disabled or failed query is not loading and still has
     * no list, and treating that as "they have no pins" would let a caller
     * write over pins that were simply never fetched.
     */
    pinsLoaded: enabled && data !== undefined,
    isSaving: mutation.isPending,
  };
}
