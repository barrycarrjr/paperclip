import { pgTable, uuid, timestamp, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Per-company agent defaults that override the instance agent defaults.
 * One row per company, created on first write. No row means the company
 * inherits everything from the instance.
 */
export const companyAgentDefaults = pgTable("company_agent_defaults", {
  companyId: uuid("company_id")
    .primaryKey()
    .references(() => companies.id, { onDelete: "cascade" }),
  agentDefaults: jsonb("agent_defaults").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
