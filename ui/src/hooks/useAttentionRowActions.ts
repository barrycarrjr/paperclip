import { useMutation, useQueryClient } from "@tanstack/react-query";
import { attentionSnoozeKey, type AttentionRow } from "@paperclipai/shared";
import { inboxDismissalsApi } from "../api/inboxDismissals";
import { invalidateAttention } from "../lib/invalidate-attention";

/**
 * The two ways to take a row off your list, and the difference between them.
 *
 * Snoozing says "not during my morning": it holds until its time is up even if
 * the item changes, because it is a decision about the operator's day rather
 * than about the item. Dismissing says "I have seen this and I am not acting on
 * it": it holds until the thing itself changes into something new.
 *
 * Both are stored per person on the server rather than in this browser, so a
 * row put away on the laptop is also away on the phone, and the badge, the
 * Briefs and the Inbox all agree it is gone. Both take the company from the
 * row rather than from the page, because the Portfolio Brief shows rows from
 * several companies at once.
 */
export function useAttentionRowActions() {
  const queryClient = useQueryClient();

  const snoozeMutation = useMutation({
    mutationFn: ({ row, until }: { row: AttentionRow; until: Date | null }) =>
      inboxDismissalsApi.snooze(row.companyId, attentionSnoozeKey(row), until),
    onSettled: (_data, _error, variables) => {
      invalidateAttention(queryClient, variables.row.companyId);
    },
  });

  const dismissMutation = useMutation({
    // Dismissal is recorded against `key`, the row's own name for the problem,
    // not against the snooze key. The server decides when a dismissal lapses by
    // comparing it with that same row, so the two have to agree on what is
    // being dismissed.
    mutationFn: (row: AttentionRow) => inboxDismissalsApi.dismiss(row.companyId, row.key),
    onSettled: (_data, _error, row) => {
      invalidateAttention(queryClient, row.companyId);
    },
  });

  return {
    snooze: (row: AttentionRow, until: Date) => snoozeMutation.mutate({ row, until }),
    unsnooze: (row: AttentionRow) => snoozeMutation.mutate({ row, until: null }),
    dismiss: (row: AttentionRow) => dismissMutation.mutate(row),
    isPending: snoozeMutation.isPending || dismissMutation.isPending,
    error: snoozeMutation.error ?? dismissMutation.error,
  };
}
