-- Durable record of an email handed off to an agent (P5a).
-- Additive only: creates one new table and touches nothing existing, so the
-- whole feature rolls back by dropping this table.
-- Constraint and index names match what drizzle-kit generates for
-- packages/db/src/schema/issue_email_delegations.ts, so a future generate
-- sees no difference and does not try to recreate them.
CREATE TABLE IF NOT EXISTS "issue_email_delegations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "issue_id" uuid NOT NULL,
  "company_id" uuid NOT NULL,
  "plugin_id" text NOT NULL,
  "source_key" text NOT NULL,
  "mailbox" text NOT NULL,
  "folder" text,
  "message_id" text,
  "status" text NOT NULL DEFAULT 'delegated',
  "delegated_by_user_id" text,
  "delegated_to_agent_id" uuid,
  "delegated_at" timestamptz NOT NULL DEFAULT now(),
  "acknowledged_at" timestamptz,
  "resolved_at" timestamptz,
  "resolution_note" text,
  "handed_back_reason" text,
  "previous_delegation_id" uuid,
  "reply_state" text NOT NULL DEFAULT 'none',
  "reply_error" text,
  "version" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "issue_email_delegations_issue_id_issues_id_fk"
    FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE CASCADE,
  CONSTRAINT "issue_email_delegations_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE,
  CONSTRAINT "issue_email_delegations_delegated_to_agent_id_agents_id_fk"
    FOREIGN KEY ("delegated_to_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL,
  CONSTRAINT "issue_email_delegations_previous_delegation_id_issue_email_delegations_id_fk"
    FOREIGN KEY ("previous_delegation_id") REFERENCES "issue_email_delegations"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_email_delegations_company_idx"
  ON "issue_email_delegations" ("company_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_email_delegations_issue_idx"
  ON "issue_email_delegations" ("issue_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_email_delegations_source_idx"
  ON "issue_email_delegations" ("company_id", "source_key");
--> statement-breakpoint
-- At most one OPEN delegation per source email per company, so a retried click
-- or a double-fired tool call cannot hand the same message off twice. Terminal
-- states are excluded so the same email can legitimately be delegated again.
CREATE UNIQUE INDEX IF NOT EXISTS "issue_email_delegations_open_source_uq"
  ON "issue_email_delegations" ("company_id", "source_key")
  WHERE "status" NOT IN ('resolved', 'handed_back', 're_delegated');
