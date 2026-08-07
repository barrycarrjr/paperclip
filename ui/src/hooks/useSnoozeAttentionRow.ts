import { useMutation, useQueryClient } from "@tanstack/react-query";
import { attentionSnoozeKey, type AttentionRow } from "@paperclipai/shared";
import { inboxDismissalsApi } from "../api/inboxDismissals";
import { invalidateAttention } from "../lib/invalidate-attention";

/**
 * Put an attention row away until a chosen moment.
 *
 * The snooze is stored per person on the server, not in this browser, so a row
 * put away on the laptop is also away on the phone, and the badge, the Briefs
 * and the Inbox all agree it is gone. A snooze holds until its time is up even
 * if the item changes, which is what separates it from dismissing.
 *
 * It takes the company from the row rather than from the page, because the
 * Portfolio Brief shows rows from several companies at once.
 */
export function useSnoozeAttentionRow() {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: ({ row, until }: { row: AttentionRow; until: Date | null }) =>
      inboxDismissalsApi.snooze(row.companyId, attentionSnoozeKey(row), until),
    onSettled: (_data, _error, variables) => {
      invalidateAttention(queryClient, variables.row.companyId);
    },
  });

  return {
    snooze: (row: AttentionRow, until: Date) => mutation.mutate({ row, until }),
    unsnooze: (row: AttentionRow) => mutation.mutate({ row, until: null }),
    isPending: mutation.isPending,
    error: mutation.error,
  };
}
