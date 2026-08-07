import type { InboxDismissal } from "@paperclipai/shared";
import { api } from "./client";

export const inboxDismissalsApi = {
  list: (companyId: string) => api.get<InboxDismissal[]>(`/companies/${companyId}/inbox-dismissals`),
  dismiss: (companyId: string, itemKey: string) =>
    api.post<InboxDismissal>(`/companies/${companyId}/inbox-dismissals`, { itemKey }),
  /** Pass null to bring it back now. */
  snooze: (companyId: string, itemKey: string, snoozedUntil: Date | null) =>
    api.post<InboxDismissal>(`/companies/${companyId}/inbox-snoozes`, {
      itemKey,
      snoozedUntil: snoozedUntil ? snoozedUntil.toISOString() : null,
    }),
};
