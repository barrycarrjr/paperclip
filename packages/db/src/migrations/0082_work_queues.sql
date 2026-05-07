CREATE TABLE IF NOT EXISTS "work_queues" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "default_assignee_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "default_project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "work_queues_company_idx" ON "work_queues" ("company_id");
CREATE UNIQUE INDEX IF NOT EXISTS "work_queues_company_slug_uq" ON "work_queues" ("company_id", "slug");

CREATE TABLE IF NOT EXISTS "work_queue_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "queue_id" uuid NOT NULL REFERENCES "work_queues"("id") ON DELETE CASCADE,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "external_source" text,
  "external_id" text,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'pending',
  "priority" integer NOT NULL DEFAULT 0,
  "claimed_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "claimed_at" timestamptz,
  "completed_at" timestamptz,
  "failed_at" timestamptz,
  "failure_reason" text,
  "issue_id" uuid REFERENCES "issues"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "work_queue_items_queue_idx" ON "work_queue_items" ("queue_id");
CREATE INDEX IF NOT EXISTS "work_queue_items_queue_status_idx"
  ON "work_queue_items" ("queue_id", "status", "priority");
CREATE UNIQUE INDEX IF NOT EXISTS "work_queue_items_queue_external_uq"
  ON "work_queue_items" ("queue_id", "external_source", "external_id");
