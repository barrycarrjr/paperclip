import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { inboxDismissals } from "@paperclipai/db";

export function inboxDismissalService(db: Db) {
  return {
    /**
     * Everything this person has put away in one company, in the shape the
     * attention queue wants. One place, because the attention route and the
     * badge route must not drift on what counts as hidden.
     */
    loadHiddenByKey: async (companyId: string, userId: string) => {
      const rows = await db
        .select({
          itemKey: inboxDismissals.itemKey,
          dismissedAt: inboxDismissals.dismissedAt,
          snoozedUntil: inboxDismissals.snoozedUntil,
        })
        .from(inboxDismissals)
        .where(and(eq(inboxDismissals.companyId, companyId), eq(inboxDismissals.userId, userId)));

      const dismissedAtByKey = new Map<string, number>();
      const snoozedUntilByKey = new Map<string, number>();
      for (const row of rows) {
        dismissedAtByKey.set(row.itemKey, new Date(row.dismissedAt).getTime());
        if (row.snoozedUntil) {
          snoozedUntilByKey.set(row.itemKey, new Date(row.snoozedUntil).getTime());
        }
      }
      return { dismissedAtByKey, snoozedUntilByKey };
    },

    list: async (companyId: string, userId: string) =>
      db
        .select()
        .from(inboxDismissals)
        .where(and(eq(inboxDismissals.companyId, companyId), eq(inboxDismissals.userId, userId)))
        .orderBy(desc(inboxDismissals.updatedAt)),

    dismiss: async (
      companyId: string,
      userId: string,
      itemKey: string,
      dismissedAt: Date = new Date(),
    ) => {
      const now = new Date();
      const [row] = await db
        .insert(inboxDismissals)
        .values({
          companyId,
          userId,
          itemKey,
          dismissedAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [inboxDismissals.companyId, inboxDismissals.userId, inboxDismissals.itemKey],
          // Only the dismissal. The two share a row but answer different
          // questions, so writing one must not silently clear the other.
          set: {
            dismissedAt,
            updatedAt: now,
          },
        })
        .returning();
      return row;
    },

    /**
     * Put an item away until a moment in the future, or lift the snooze by
     * passing null. Unlike a dismissal this holds even when the item changes.
     */
    snooze: async (
      companyId: string,
      userId: string,
      itemKey: string,
      snoozedUntil: Date | null,
    ) => {
      const now = new Date();
      const [row] = await db
        .insert(inboxDismissals)
        .values({
          companyId,
          userId,
          itemKey,
          // A brand-new row exists only for the snooze. Dating the dismissal
          // in the distant past keeps it inert: the dismissal rule is
          // "dismissed at or after the item last changed", and nothing is
          // older than this.
          dismissedAt: new Date(0),
          snoozedUntil,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [inboxDismissals.companyId, inboxDismissals.userId, inboxDismissals.itemKey],
          set: {
            snoozedUntil,
            updatedAt: now,
          },
        })
        .returning();
      return row;
    },
  };
}
