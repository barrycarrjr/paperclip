import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

export const userSidebarPreferences = pgTable(
  "user_sidebar_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    companyOrder: jsonb("company_order").$type<string[]>().notNull().default([]),
    portfolioNavOrder: jsonb("portfolio_nav_order").$type<string[]>().notNull().default([]),
    /**
     * Workspaces this person has pinned to their sidebar, in the order they
     * want them, as catalog ids ("email") or plugin route paths ("notepad").
     *
     * Per user and not per company on purpose: a pin says "this is a tool I
     * use", which is a fact about the person, and re-pinning Phone in every
     * company would be the kind of repeated setup this project exists to
     * remove. A pinned workspace that a given company cannot open is simply
     * not shown there.
     */
    pinnedWorkspaces: jsonb("pinned_workspaces").$type<string[]>().notNull().default([]),
    pageSectionOrders: jsonb("page_section_orders")
      .$type<Record<string, string[]>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userUq: uniqueIndex("user_sidebar_preferences_user_uq").on(table.userId),
  }),
);
