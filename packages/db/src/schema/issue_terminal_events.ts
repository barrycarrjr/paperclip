import { integer, pgTable, uuid, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

// The status trigger increments version in the writer's transaction. Keeping
// one row per issue preserves reclose generations without an event history.
export const issueTerminalEvents = pgTable("issue_terminal_events", {
  issueId: uuid("issue_id").primaryKey().references(() => issues.id, { onDelete: "cascade" }),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(1),
  processedVersion: integer("processed_version").notNull().default(0),
}, (table) => ({
  companyIdx: index("issue_terminal_events_company_idx").on(table.companyId),
}));
