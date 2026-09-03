import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/**
 * Durable record of an email handed to an agent (P5a — see
 * docs/plans/2026-09-03-p5a-email-delegation-spec.md).
 *
 * Why a table rather than more columns on `issues`: the issue's own
 * `originKind`/`originId` already answer "which email is this from" (added
 * in P5a phase 1, no migration needed). What they can't hold is the
 * delegation's own lifecycle — who handed it over, whether the agent ever
 * picked it up, whether it was handed back and re-delegated to someone else,
 * and whether a reply went out on resolution. That history has to survive
 * independently of whatever `issue.status` does later, because an issue can
 * be reopened, reassigned, or closed by someone with no connection to the
 * original handoff, and the delegation record shouldn't silently claim that
 * as its own outcome.
 *
 * Additive only: nothing here alters an existing table, so rolling the whole
 * feature back is dropping this table alone.
 */
export const issueEmailDelegations = pgTable(
  "issue_email_delegations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),

    /** Which email plugin the source lives in (email-tools, help-scout, ...). */
    pluginId: text("plugin_id").notNull(),
    /**
     * The same versioned key stored in `issues.origin_id`
     * (`buildEmailHandoffOriginId`). Kept here too so a delegation can be
     * found by source without joining, and so the reference survives even if
     * the issue's own origin columns are ever repurposed.
     */
    sourceKey: text("source_key").notNull(),
    mailbox: text("mailbox").notNull(),
    /** Null for providers without folders (Help Scout). */
    folder: text("folder"),
    /** Null when the provider gave no Message-Id and the key fell back to uid. */
    messageId: text("message_id"),

    /**
     * delegated | acknowledged | in_progress | needs_review | resolved
     * | handed_back | re_delegated. Text, not an enum, matching how every
     * other status column in this schema is done (`issues.status`,
     * `work_queue_items.status`) — adding a state later shouldn't need a
     * migration.
     */
    status: text("status").notNull().default("delegated"),

    delegatedByUserId: text("delegated_by_user_id"),
    delegatedToAgentId: uuid("delegated_to_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    delegatedAt: timestamp("delegated_at", { withTimezone: true }).notNull().defaultNow(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionNote: text("resolution_note"),
    /** Required by the contract whenever status becomes handed_back. */
    handedBackReason: text("handed_back_reason"),
    /** Chain, not overwrite: "who touched this and when" stays answerable. */
    previousDelegationId: uuid("previous_delegation_id").references(
      (): AnyPgColumn => issueEmailDelegations.id,
      { onDelete: "set null" },
    ),

    /**
     * none | queued | sent | failed — whether resolution produced a reply to
     * the original sender. "queued" is the normal outcome while the instance's
     * outbound-approval setting is on: the reply waits in Approvals rather
     * than sending.
     */
    replyState: text("reply_state").notNull().default("none"),
    replyError: text("reply_error"),

    /** Optimistic concurrency guard (spec §4.3). */
    version: integer("version").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("issue_email_delegations_company_idx").on(table.companyId, table.status),
    issueIdx: index("issue_email_delegations_issue_idx").on(table.issueId),
    sourceIdx: index("issue_email_delegations_source_idx").on(table.companyId, table.sourceKey),
    /**
     * Idempotency (spec §4.2): at most one OPEN delegation per source email
     * per company, so a retried click or a double-fired tool call can't hand
     * the same message off twice. Terminal states are excluded so the same
     * email can legitimately be delegated again later (a genuine
     * re-delegation, which also carries previousDelegationId).
     *
     * Mirrors the existing partial-unique pattern already used for routine
     * executions and recovery incidents in issues.ts.
     */
    openSourceUq: uniqueIndex("issue_email_delegations_open_source_uq")
      .on(table.companyId, table.sourceKey)
      .where(sql`${table.status} not in ('resolved', 'handed_back', 're_delegated')`),
  }),
);
