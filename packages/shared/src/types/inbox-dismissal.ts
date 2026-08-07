export interface InboxDismissal {
  id: string;
  companyId: string;
  userId: string;
  itemKey: string;
  dismissedAt: Date;
  /**
   * Put away until this moment, or null. Unlike dismissedAt this holds even
   * when the item changes, so "not until tomorrow" survives an edit.
   */
  snoozedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
