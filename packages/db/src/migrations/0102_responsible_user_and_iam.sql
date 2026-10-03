CREATE TABLE IF NOT EXISTS "folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"system_key" text,
	"color" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_secret_provider_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"display_name" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"health_status" text,
	"health_checked_at" timestamp with time zone,
	"health_message" text,
	"health_details" jsonb,
	"disabled_at" timestamp with time zone,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_secret_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"provider" text DEFAULT 'local_encrypted' NOT NULL,
	"managed_mode" text DEFAULT 'paperclip_managed' NOT NULL,
	"provider_config_id" uuid,
	"provider_metadata" jsonb,
	"usage_guidance" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"updated_by_agent_id" uuid,
	"updated_by_user_id" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_secret_declarations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_secret_definition_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"config_path" text NOT NULL,
	"env_key" text NOT NULL,
	"version_selector" text DEFAULT 'latest' NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"allow_missing_override" boolean DEFAULT false NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "secret_access_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"secret_id" uuid,
	"user_secret_definition_id" uuid,
	"secret_scope" text DEFAULT 'company' NOT NULL,
	"version" integer,
	"provider" text NOT NULL,
	"responsible_user_id" text,
	"credential_owner_user_id" text,
	"credential_subject_type" text,
	"credential_subject_id" text,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"consumer_type" text NOT NULL,
	"consumer_id" text NOT NULL,
	"config_path" text,
	"issue_id" uuid,
	"heartbeat_run_id" uuid,
	"plugin_id" uuid,
	"outcome" text NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "routine_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"snapshot" jsonb NOT NULL,
	"change_summary" text,
	"restored_from_revision_id" uuid,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_by_run_id" uuid,
	"responsible_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "routine_webhook_test_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"trigger_id" uuid NOT NULL,
	"delivery_key_hash" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "default_responsible_user_id" text;
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "responsible_user_id" text;
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "origin_identity_context_id" uuid;
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "continuation_identity_context_id" uuid;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "responsible_user_id" text;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "active_identity_context_id" uuid;
--> statement-breakpoint
ALTER TABLE "agent_api_keys" ADD COLUMN IF NOT EXISTS "responsible_user_id" text;
--> statement-breakpoint
ALTER TABLE "agent_api_keys" ADD COLUMN IF NOT EXISTS "scope_config" jsonb;
--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "responsible_user_id" text;
--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "folder_id" uuid;
--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "activity_gate_policy" text DEFAULT 'always' NOT NULL;
--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "activity_gate_scope" text DEFAULT 'company' NOT NULL;
--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "origin_kind" text DEFAULT 'manual' NOT NULL;
--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "origin_id" text;
--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "env" jsonb;
--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "latest_revision_id" uuid;
--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "latest_revision_number" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "routine_triggers" ADD COLUMN IF NOT EXISTS "setup_pending" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "routine_triggers" ADD COLUMN IF NOT EXISTS "archived" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "routine_triggers" ADD COLUMN IF NOT EXISTS "last_webhook_delivery" jsonb;
--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN IF NOT EXISTS "responsible_user_id" text;
--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN IF NOT EXISTS "routine_revision_id" uuid;
--> statement-breakpoint
ALTER TABLE "activity_log" ADD COLUMN IF NOT EXISTS "responsible_user_id" text;
--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "key" text;
--> statement-breakpoint
UPDATE "company_secrets"
SET "key" = LOWER(REGEXP_REPLACE("name", '[^a-zA-Z0-9_]+', '_', 'g'))
WHERE "key" IS NULL;
--> statement-breakpoint
ALTER TABLE "company_secrets" ALTER COLUMN "key" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "scope" text DEFAULT 'company' NOT NULL;
--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "owner_user_id" text;
--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "user_secret_definition_id" uuid;
--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active' NOT NULL;
--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "managed_mode" text DEFAULT 'paperclip_managed' NOT NULL;
--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "provider_config_id" uuid;
--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "provider_metadata" jsonb;
--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "last_resolved_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "last_rotated_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "company_secrets"
SET "scope" = 'company'
WHERE "scope" IS NULL;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_secrets_scope_shape_check') THEN
		ALTER TABLE "company_secrets" ADD CONSTRAINT "company_secrets_scope_shape_check" CHECK (
			("scope" = 'company' AND "owner_user_id" IS NULL AND "user_secret_definition_id" IS NULL)
			OR
			("scope" = 'user' AND "owner_user_id" IS NOT NULL AND "user_secret_definition_id" IS NOT NULL)
		);
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'folders_company_id_companies_id_fk') THEN
		ALTER TABLE "folders" ADD CONSTRAINT "folders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'folders_parent_id_folders_id_fk') THEN
		ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_id_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."folders"("id") ON DELETE restrict ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_secret_declarations_company_id_companies_id_fk') THEN
		ALTER TABLE "user_secret_declarations" ADD CONSTRAINT "user_secret_declarations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_secret_declarations_user_secret_definition_id_user_secret_definitions_id_fk') THEN
		ALTER TABLE "user_secret_declarations" ADD CONSTRAINT "user_secret_declarations_user_secret_definition_id_user_secret_definitions_id_fk" FOREIGN KEY ("user_secret_definition_id") REFERENCES "public"."user_secret_definitions"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_secrets_user_secret_definition_id_user_secret_definitions_id_fk') THEN
		ALTER TABLE "company_secrets" ADD CONSTRAINT "company_secrets_user_secret_definition_id_user_secret_definitions_id_fk" FOREIGN KEY ("user_secret_definition_id") REFERENCES "public"."user_secret_definitions"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_secrets_provider_config_id_company_secret_provider_configs_id_fk') THEN
		ALTER TABLE "company_secrets" ADD CONSTRAINT "company_secrets_provider_config_id_company_secret_provider_configs_id_fk" FOREIGN KEY ("provider_config_id") REFERENCES "public"."company_secret_provider_configs"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'secret_access_events_company_id_companies_id_fk') THEN
		ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'secret_access_events_secret_id_company_secrets_id_fk') THEN
		ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'secret_access_events_user_secret_definition_id_user_secret_definitions_id_fk') THEN
		ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_user_secret_definition_id_user_secret_definitions_id_fk" FOREIGN KEY ("user_secret_definition_id") REFERENCES "public"."user_secret_definitions"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'secret_access_events_issue_id_issues_id_fk') THEN
		ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'secret_access_events_heartbeat_run_id_heartbeat_runs_id_fk') THEN
		ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'secret_access_events_plugin_id_plugins_id_fk') THEN
		ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routine_revisions_company_id_companies_id_fk') THEN
		ALTER TABLE "routine_revisions" ADD CONSTRAINT "routine_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routine_revisions_routine_id_routines_id_fk') THEN
		ALTER TABLE "routine_revisions" ADD CONSTRAINT "routine_revisions_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routine_revisions_restored_from_revision_id_routine_revisions_id_fk') THEN
		ALTER TABLE "routine_revisions" ADD CONSTRAINT "routine_revisions_restored_from_revision_id_routine_revisions_id_fk" FOREIGN KEY ("restored_from_revision_id") REFERENCES "public"."routine_revisions"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routine_revisions_created_by_agent_id_agents_id_fk') THEN
		ALTER TABLE "routine_revisions" ADD CONSTRAINT "routine_revisions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routine_revisions_created_by_run_id_heartbeat_runs_id_fk') THEN
		ALTER TABLE "routine_revisions" ADD CONSTRAINT "routine_revisions_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routine_webhook_test_receipts_company_id_companies_id_fk') THEN
		ALTER TABLE "routine_webhook_test_receipts" ADD CONSTRAINT "routine_webhook_test_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routine_webhook_test_receipts_trigger_id_routine_triggers_id_fk') THEN
		ALTER TABLE "routine_webhook_test_receipts" ADD CONSTRAINT "routine_webhook_test_receipts_trigger_id_routine_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."routine_triggers"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "folders_company_kind_position_idx" ON "folders" USING btree ("company_id", "kind", "position", "name");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "folders_company_kind_root_slug_uq" ON "folders" USING btree ("company_id", "kind", "slug") WHERE ("parent_id" IS NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "folders_company_kind_parent_slug_uq" ON "folders" USING btree ("company_id", "kind", "parent_id", "slug") WHERE ("parent_id" IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "folders_company_kind_system_key_uq" ON "folders" USING btree ("company_id", "kind", "system_key") WHERE ("system_key" IS NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "folders_company_kind_parent_position_idx" ON "folders" USING btree ("company_id", "kind", "parent_id", "position", "name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_secret_provider_configs_company_idx" ON "company_secret_provider_configs" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_secret_provider_configs_company_provider_idx" ON "company_secret_provider_configs" USING btree ("company_id", "provider");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_secret_provider_configs_default_uq" ON "company_secret_provider_configs" USING btree ("company_id", "provider") WHERE ("is_default" = true);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_secret_definitions_company_status_idx" ON "user_secret_definitions" USING btree ("company_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_secret_definitions_company_provider_idx" ON "user_secret_definitions" USING btree ("company_id", "provider");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_secret_definitions_provider_config_idx" ON "user_secret_definitions" USING btree ("provider_config_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_secret_definitions_company_key_uq" ON "user_secret_definitions" USING btree ("company_id", "key") WHERE ("deleted_at" IS NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_secret_declarations_company_idx" ON "user_secret_declarations" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_secret_declarations_definition_idx" ON "user_secret_declarations" USING btree ("user_secret_definition_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_secret_declarations_target_idx" ON "user_secret_declarations" USING btree ("company_id", "target_type", "target_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_secret_declarations_company_required_idx" ON "user_secret_declarations" USING btree ("company_id", "required");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_secret_declarations_target_path_uq" ON "user_secret_declarations" USING btree ("company_id", "target_type", "target_id", "config_path");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_secret_declarations_required_override_idx" ON "user_secret_declarations" USING btree ("company_id", "allow_missing_override") WHERE ("allow_missing_override" = true);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secret_access_events_company_created_idx" ON "secret_access_events" USING btree ("company_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secret_access_events_secret_created_idx" ON "secret_access_events" USING btree ("secret_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secret_access_events_user_definition_created_idx" ON "secret_access_events" USING btree ("user_secret_definition_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secret_access_events_company_credential_owner_idx" ON "secret_access_events" USING btree ("company_id", "credential_owner_user_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secret_access_events_consumer_idx" ON "secret_access_events" USING btree ("company_id", "consumer_type", "consumer_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secret_access_events_run_idx" ON "secret_access_events" USING btree ("heartbeat_run_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "routine_revisions_routine_revision_uq" ON "routine_revisions" USING btree ("routine_id", "revision_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routine_revisions_company_routine_created_idx" ON "routine_revisions" USING btree ("company_id", "routine_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routine_revisions_company_responsible_user_idx" ON "routine_revisions" USING btree ("company_id", "responsible_user_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "routine_webhook_test_receipts_delivery_uq" ON "routine_webhook_test_receipts" USING btree ("trigger_id", "delivery_key_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "companies_default_responsible_user_idx" ON "companies" ("default_responsible_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_company_responsible_user_idx" ON "issues" USING btree ("company_id", "responsible_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_responsible_user_idx" ON "heartbeat_runs" USING btree ("company_id", "responsible_user_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routines_company_responsible_user_idx" ON "routines" USING btree ("company_id", "responsible_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routine_runs_revision_idx" ON "routine_runs" USING btree ("routine_revision_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routine_runs_company_responsible_user_idx" ON "routine_runs" USING btree ("company_id", "responsible_user_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_log_company_responsible_user_created_idx" ON "activity_log" USING btree ("company_id", "responsible_user_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_secrets_company_scope_idx" ON "company_secrets" USING btree ("company_id", "scope");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_secrets_company_owner_idx" ON "company_secrets" USING btree ("company_id", "owner_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_secrets_user_definition_owner_idx" ON "company_secrets" USING btree ("company_id", "user_secret_definition_id", "owner_user_id");
--> statement-breakpoint
DROP INDEX IF EXISTS "company_secrets_company_name_uq";
--> statement-breakpoint
DROP INDEX IF EXISTS "company_secrets_company_key_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_secrets_company_name_uq" ON "company_secrets" USING btree ("company_id", "name") WHERE ("scope" = 'company' AND "deleted_at" IS NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_secrets_company_key_uq" ON "company_secrets" USING btree ("company_id", "key") WHERE ("scope" = 'company' AND "deleted_at" IS NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_secrets_user_definition_owner_uq" ON "company_secrets" USING btree ("company_id", "user_secret_definition_id", "owner_user_id") WHERE ("scope" = 'user' AND "deleted_at" IS NULL);
--> statement-breakpoint
WITH owner_defaults AS (
  SELECT DISTINCT ON ("company_id")
    "company_id",
    "principal_id" AS "user_id"
  FROM "company_memberships"
  WHERE "principal_type" = 'user'
    AND "status" = 'active'
    AND "membership_role" = 'owner'
  ORDER BY "company_id", "created_at" ASC, "id" ASC
)
UPDATE "companies" AS c
SET "default_responsible_user_id" = owner_defaults."user_id"
FROM owner_defaults
WHERE c."id" = owner_defaults."company_id"
  AND c."default_responsible_user_id" IS NULL;
--> statement-breakpoint
WITH RECURSIVE issue_chain AS (
  SELECT
    child."id" AS "issue_id",
    child."company_id",
    child."parent_id",
    child."responsible_user_id",
    child."created_by_user_id",
    0 AS "depth"
  FROM "issues" AS child
  WHERE child."responsible_user_id" IS NULL
  UNION ALL
  SELECT
    issue_chain."issue_id",
    parent."company_id",
    parent."parent_id",
    parent."responsible_user_id",
    parent."created_by_user_id",
    issue_chain."depth" + 1
  FROM issue_chain
  JOIN "issues" AS parent
    ON parent."id" = issue_chain."parent_id"
   AND parent."company_id" = issue_chain."company_id"
  WHERE issue_chain."depth" < 50
),
resolved_issue_users AS (
  SELECT DISTINCT ON ("issue_id")
    "issue_id",
    COALESCE("responsible_user_id", "created_by_user_id") AS "user_id"
  FROM issue_chain
  WHERE COALESCE("responsible_user_id", "created_by_user_id") IS NOT NULL
  ORDER BY "issue_id", "depth" ASC
)
UPDATE "issues" AS i
SET "responsible_user_id" = resolved_issue_users."user_id"
FROM resolved_issue_users
WHERE i."id" = resolved_issue_users."issue_id"
  AND i."responsible_user_id" IS NULL;
--> statement-breakpoint
UPDATE "issues" AS i
SET "responsible_user_id" = c."default_responsible_user_id"
FROM "companies" AS c
WHERE i."company_id" = c."id"
  AND i."responsible_user_id" IS NULL
  AND c."default_responsible_user_id" IS NOT NULL;
--> statement-breakpoint
WITH routine_responsible_users AS (
  SELECT
    r."id",
    COALESCE(r."created_by_user_id", parent_issue."responsible_user_id", c."default_responsible_user_id") AS "user_id"
  FROM "routines" AS r
  JOIN "companies" AS c ON c."id" = r."company_id"
  LEFT JOIN "issues" AS parent_issue
    ON parent_issue."id" = r."parent_issue_id"
   AND parent_issue."company_id" = r."company_id"
  WHERE r."responsible_user_id" IS NULL
)
UPDATE "routines" AS r
SET "responsible_user_id" = routine_responsible_users."user_id"
FROM routine_responsible_users
WHERE r."id" = routine_responsible_users."id"
  AND routine_responsible_users."user_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "heartbeat_runs" AS h
SET "responsible_user_id" = c."default_responsible_user_id"
FROM "companies" AS c
WHERE h."company_id" = c."id"
  AND h."responsible_user_id" IS NULL
  AND c."default_responsible_user_id" IS NOT NULL;
