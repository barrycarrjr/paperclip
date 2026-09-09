-- Repeat-safe plugin operations: one row per attempt at an operation that
-- changes something, so a retried call replays its result instead of doing the
-- work twice (sending the same email, filing the same ticket).
-- Additive only: creates one new table and touches nothing existing, so the
-- whole feature rolls back by dropping this table.
-- Constraint and index names match what drizzle-kit generates for
-- packages/db/src/schema/plugin_operation_calls.ts, so a future generate sees
-- no difference and does not try to recreate them.
CREATE TABLE IF NOT EXISTS "plugin_operation_calls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "plugin_id" text NOT NULL,
  "operation_key" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "company_id" uuid,
  "status" text NOT NULL DEFAULT 'in_progress',
  "result_json" jsonb,
  "invoked_by" text NOT NULL DEFAULT 'agent',
  "run_id" text,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "plugin_operation_calls_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE
);
--> statement-breakpoint
-- Two partial indexes rather than one: Postgres treats NULLs as distinct in a
-- unique index, so a single index over a nullable company_id would let every
-- instance-admin global call repeat freely.
CREATE UNIQUE INDEX IF NOT EXISTS "plugin_operation_calls_scoped_key_uq"
  ON "plugin_operation_calls" ("plugin_id", "operation_key", "idempotency_key", "company_id")
  WHERE "company_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plugin_operation_calls_global_key_uq"
  ON "plugin_operation_calls" ("plugin_id", "operation_key", "idempotency_key")
  WHERE "company_id" IS NULL;
--> statement-breakpoint
-- Retry windows are measured in minutes; without this the table grows forever.
CREATE INDEX IF NOT EXISTS "plugin_operation_calls_expiry_idx"
  ON "plugin_operation_calls" ("expires_at");
