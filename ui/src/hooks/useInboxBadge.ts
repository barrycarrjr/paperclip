import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { inboxDismissalsApi } from "../api/inboxDismissals";
import { sidebarBadgesApi } from "../api/sidebarBadges";
import { queryKeys } from "../lib/queryKeys";
import { invalidateAttention } from "../lib/invalidate-attention";
import {
  buildInboxDismissedAtByKey,
  loadDismissedInboxAlerts,
  saveDismissedInboxAlerts,
  loadReadInboxItems,
  saveReadInboxItems,
  READ_ITEMS_KEY,
} from "../lib/inbox";
import type { InboxBadgeData } from "../lib/inbox";

export function useDismissedInboxAlerts() {
  const [dismissed, setDismissed] = useState<Set<string>>(loadDismissedInboxAlerts);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== "paperclip:inbox:dismissed") return;
      setDismissed(loadDismissedInboxAlerts());
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const dismiss = (id: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      saveDismissedInboxAlerts(next);
      return next;
    });
  };

  return { dismissed, dismiss };
}

export function useInboxDismissals(companyId: string | null | undefined) {
  const queryClient = useQueryClient();
  const queryKey = companyId
    ? queryKeys.inboxDismissals(companyId)
    : ["inbox-dismissals", "__disabled__"] as const;

  const { data: dismissals = [] } = useQuery({
    queryKey,
    queryFn: () => inboxDismissalsApi.list(companyId!),
    enabled: !!companyId,
  });

  const dismissMutation = useMutation({
    mutationFn: ({ itemKey }: { itemKey: string }) => inboxDismissalsApi.dismiss(companyId!, itemKey),
    onMutate: async ({ itemKey }) => {
      if (!companyId) return { previous: [] as typeof dismissals };
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<typeof dismissals>(queryKey) ?? [];
      const now = new Date();
      queryClient.setQueryData(queryKey, [
        {
          id: `optimistic:${itemKey}`,
          companyId,
          userId: "me",
          itemKey,
          dismissedAt: now,
          createdAt: now,
          updatedAt: now,
        },
        ...previous.filter((dismissal) => dismissal.itemKey !== itemKey),
      ]);
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (!context) return;
      queryClient.setQueryData(queryKey, context.previous);
    },
    onSettled: () => {
      if (!companyId) return;
      queryClient.invalidateQueries({ queryKey });
      invalidateAttention(queryClient, companyId);
    },
  });

  const dismissedAtByKey = useMemo(
    () => buildInboxDismissedAtByKey(dismissals),
    [dismissals],
  );

  return {
    dismissals,
    dismissedAtByKey,
    dismiss: (itemKey: string) => dismissMutation.mutate({ itemKey }),
    isPending: dismissMutation.isPending,
  };
}

export function useReadInboxItems() {
  const [readItems, setReadItems] = useState<Set<string>>(loadReadInboxItems);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== READ_ITEMS_KEY) return;
      setReadItems(loadReadInboxItems());
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const markRead = (id: string) => {
    setReadItems((prev) => {
      const next = new Set(prev);
      next.add(id);
      saveReadInboxItems(next);
      return next;
    });
  };

  const markUnread = (id: string) => {
    setReadItems((prev) => {
      const next = new Set(prev);
      next.delete(id);
      saveReadInboxItems(next);
      return next;
    });
  };

  return { readItems, markRead, markUnread };
}

/**
 * The badge is a count of the attention queue, nothing else. It used to be
 * its own sum over five separate queries - approvals, join requests, failed
 * runs, unread issues, and two company-health alerts - which is why the
 * number beside the Inbox and the number on the company avatar could differ
 * from each other and from the list they both pointed at.
 *
 * Two things it deliberately no longer counts: issues you have not read
 * (a read-state, not a decision anyone has to make) and health alerts
 * (nothing to decide, and nothing to click).
 */
const EMPTY_BADGE: InboxBadgeData = { inbox: 0, approvals: 0, failedRuns: 0, joinRequests: 0 };

export function useInboxBadge(companyId: string | null | undefined): InboxBadgeData {
  // The same endpoint and the same cache entry the company rail reads, so the
  // number beside the Inbox and the number on the company avatar cannot drift
  // apart - they are literally the same fetch. The server derives it by
  // counting attention-queue rows, so it also matches the list it points at.
  const { data } = useQuery({
    queryKey: queryKeys.sidebarBadges(companyId!),
    queryFn: () => sidebarBadgesApi.get(companyId!),
    enabled: !!companyId,
    // Same cadence the rail uses, so the two never sit at different ages.
    // On mobile the rail is not mounted at all and this is the only poll.
    refetchInterval: 15_000,
  });

  return data ?? EMPTY_BADGE;
}
