CREATE TABLE IF NOT EXISTS "routine_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "description" text,
  "routine_title" text NOT NULL,
  "routine_description" text,
  "priority" text NOT NULL DEFAULT 'medium',
  "concurrency_policy" text NOT NULL DEFAULT 'coalesce_if_active',
  "catch_up_policy" text NOT NULL DEFAULT 'skip_missed',
  "variables" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "default_assignee_role" text,
  "created_by_user_id" text,
  "updated_by_user_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "routine_templates_name_idx" ON "routine_templates" ("name");

CREATE TABLE IF NOT EXISTS "routine_template_triggers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "template_id" uuid NOT NULL REFERENCES "routine_templates"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "label" text,
  "enabled" boolean NOT NULL DEFAULT true,
  "cron_expression" text,
  "timezone" text,
  "signing_mode" text,
  "replay_window_sec" integer,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "routine_template_triggers_template_idx"
  ON "routine_template_triggers" ("template_id", "sort_order");

CREATE TABLE IF NOT EXISTS "agent_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "description" text,
  "agent_name" text NOT NULL,
  "role" text NOT NULL DEFAULT 'general',
  "title" text,
  "icon" text,
  "capabilities" text,
  "adapter_type" text NOT NULL DEFAULT 'process',
  "adapter_config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "runtime_config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "permissions" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "forbidden_write_paths" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "budget_monthly_cents" integer NOT NULL DEFAULT 0,
  "created_by_user_id" text,
  "updated_by_user_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "agent_templates_name_idx" ON "agent_templates" ("name");

CREATE TABLE IF NOT EXISTS "skill_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "description" text,
  "skill_key" text NOT NULL,
  "skill_name" text NOT NULL,
  "skill_description" text,
  "markdown" text NOT NULL,
  "created_by_user_id" text,
  "updated_by_user_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "skill_templates_name_idx" ON "skill_templates" ("name");
CREATE UNIQUE INDEX IF NOT EXISTS "skill_templates_skill_key_idx" ON "skill_templates" ("skill_key");

CREATE TABLE IF NOT EXISTS "template_deployments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "template_type" text NOT NULL,
  "template_id" uuid NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "deployed_entity_id" uuid,
  "deployed_at" timestamptz NOT NULL DEFAULT now(),
  "deployed_by_user_id" text,
  "last_synced_at" timestamptz,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS "template_deployments_template_idx"
  ON "template_deployments" ("template_type", "template_id");
CREATE INDEX IF NOT EXISTS "template_deployments_company_idx"
  ON "template_deployments" ("company_id");
CREATE UNIQUE INDEX IF NOT EXISTS "template_deployments_template_company_uq"
  ON "template_deployments" ("template_type", "template_id", "company_id");
