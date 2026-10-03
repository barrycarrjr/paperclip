import { pgTable, uuid, text, integer, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * `memory_folders` — one row per company that mirrors its memories to a plain
 * folder of Markdown files on disk (typically a synced folder such as Google
 * Drive). Paperclip's `memories` table stays the encrypted source of record;
 * the folder is the portable, tool-neutral copy that any AI or person can
 * read, and files added or edited there are imported back.
 */
export const memoryFolders = pgTable(
  "memory_folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Absolute path of the folder on the server's disk. */
    path: text("path").notNull(),
    /** Minutes between automatic syncs; null means manual only. */
    scheduleMinutes: integer("schedule_minutes"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastResult: jsonb("last_result").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUq: uniqueIndex("memory_folders_company_uq").on(table.companyId),
  }),
);
