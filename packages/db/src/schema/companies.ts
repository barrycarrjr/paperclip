import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, timestamp, boolean, uniqueIndex } from "drizzle-orm/pg-core";

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active"),
    pauseReason: text("pause_reason"),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    issuePrefix: text("issue_prefix").notNull().default("PAP"),
    issueCounter: integer("issue_counter").notNull().default(0),
    budgetMonthlyCents: integer("budget_monthly_cents").notNull().default(0),
    spentMonthlyCents: integer("spent_monthly_cents").notNull().default(0),
    requireBoardApprovalForNewAgents: boolean("require_board_approval_for_new_agents")
      .notNull()
      .default(false),
    brandColor: text("brand_color"),
    isPortfolioRoot: boolean("is_portfolio_root").notNull().default(false),
    /**
     * `standard` — an ordinary company people share.
     * `personal`  — belongs to exactly one user; see `ownerUserId`.
     *
     * Portfolio root stays on `isPortfolioRoot` above rather than becoming a
     * third value here: it already carries a database-level singleton index,
     * and 112 call sites read it.
     */
    kind: text("kind").notNull().default("standard"),
    /**
     * Set only when `kind = 'personal'`, and then never changed. This is the
     * whole basis of the isolation — no membership row, invite, or admin flag
     * grants access to a personal company, only being this user.
     */
    ownerUserId: text("owner_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issuePrefixUniqueIdx: uniqueIndex("companies_issue_prefix_idx").on(table.issuePrefix),
    portfolioRootSingletonUq: uniqueIndex("companies_portfolio_root_singleton_uq")
      .on(table.isPortfolioRoot)
      .where(sql`${table.isPortfolioRoot} = true`),
    // One personal company per person, enforced in the database so a retried
    // provision cannot leave someone with two.
    personalOwnerUq: uniqueIndex("companies_personal_owner_uq")
      .on(table.ownerUserId)
      .where(sql`${table.kind} = 'personal'`),
  }),
);
