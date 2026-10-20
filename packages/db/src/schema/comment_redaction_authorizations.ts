import { pgTable, uuid, text, timestamp, jsonb, boolean, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { issueComments } from "./issue_comments.js";
import { agents } from "./agents.js";

/** One use, board-issued permission. Stores positions and a version digest, never selected text. */
export const commentRedactionAuthorizations = pgTable("comment_redaction_authorizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  commentId: uuid("comment_id").notNull().references(() => issueComments.id, { onDelete: "cascade" }),
  instructionCommentId: uuid("instruction_comment_id").notNull().references(() => issueComments.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  requestedByUserId: text("requested_by_user_id").notNull(),
  requestedByLocalBoard: boolean("requested_by_local_board").notNull().default(false),
  bodyDigest: text("body_digest").notNull(),
  ranges: jsonb("ranges").$type<Array<{ start: number; length: number }>>().notNull(),
  keepLast4: boolean("keep_last4").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ companyIssueIdx: index("comment_redaction_authorizations_company_issue_idx").on(t.companyId, t.issueId) }));
