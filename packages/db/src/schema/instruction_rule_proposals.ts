import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { approvals } from "./approvals.js";
import { companies } from "./companies.js";
import { issueComments } from "./issue_comments.js";
import { issues } from "./issues.js";

export const instructionRuleProposals = pgTable(
  "instruction_rule_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    approvalId: uuid("approval_id").notNull().references(() => approvals.id, { onDelete: "cascade" }),
    sourceIssueId: uuid("source_issue_id").references(() => issues.id, { onDelete: "set null" }),
    sourceCommentId: uuid("source_comment_id").references(() => issueComments.id, { onDelete: "set null" }),
    targetAgentId: uuid("target_agent_id").references(() => agents.id, { onDelete: "set null" }),
    scope: text("scope").notNull(),
    rule: text("rule").notNull(),
    rationale: text("rationale"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    approvalUnique: uniqueIndex("instruction_rule_proposals_approval_unique").on(table.approvalId),
    sourceAgentUnique: uniqueIndex("instruction_rule_proposals_source_agent_unique").on(
      table.sourceCommentId,
      table.targetAgentId,
    ),
    companyScopeIdx: index("instruction_rule_proposals_company_scope_idx").on(
      table.companyId,
      table.scope,
    ),
    targetAgentIdx: index("instruction_rule_proposals_target_agent_idx").on(table.targetAgentId),
  }),
);
