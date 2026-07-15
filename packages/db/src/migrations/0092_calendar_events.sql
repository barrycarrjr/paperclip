CREATE TABLE IF NOT EXISTS "calendar_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "kind" text NOT NULL DEFAULT 'reminder',
  "title" text NOT NULL,
  "body" text,
  "status" text NOT NULL DEFAULT 'active',
  "schedule_kind" text NOT NULL,
  "anchor_at" timestamptz,
  "interval_unit" text,
  "interval_count" integer,
  "time_of_day" text,
  "cron_expression" text,
  "timezone" text NOT NULL DEFAULT 'UTC',
  "end_at" timestamptz,
  "max_occurrences" integer,
  "all_day" boolean NOT NULL DEFAULT false,
  "duration_minutes" integer,
  "next_run_at" timestamptz,
  "last_fired_at" timestamptz,
  "occurrence_count" integer NOT NULL DEFAULT 0,
  "notify" boolean NOT NULL DEFAULT true,
  "channels" jsonb NOT NULL DEFAULT '["desktop"]'::jsonb,
  "lead_time_minutes" integer NOT NULL DEFAULT 0,
  "slack_target" text,
  "source" text NOT NULL DEFAULT 'paperclip',
  "external_id" text,
  "external_calendar_id" text,
  "created_by_user_id" text,
  "created_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "updated_by_user_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "calendar_events_company_user_idx" ON "calendar_events" ("company_id", "user_id");
CREATE INDEX IF NOT EXISTS "calendar_events_next_run_idx" ON "calendar_events" ("next_run_at");
CREATE INDEX IF NOT EXISTS "calendar_events_status_idx" ON "calendar_events" ("status");
CREATE INDEX IF NOT EXISTS "calendar_events_company_anchor_idx" ON "calendar_events" ("company_id", "anchor_at");

CREATE TABLE IF NOT EXISTS "calendar_event_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "event_id" uuid NOT NULL REFERENCES "calendar_events"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "channel" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "title" text NOT NULL,
  "body" text,
  "url" text,
  "scheduled_for" timestamptz NOT NULL,
  "fired_at" timestamptz NOT NULL DEFAULT now(),
  "delivered_at" timestamptz,
  "failure_reason" text,
  "dedupe_key" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "calendar_event_deliveries_dedupe_key_uq" ON "calendar_event_deliveries" ("dedupe_key");
CREATE INDEX IF NOT EXISTS "calendar_event_deliveries_user_channel_status_idx" ON "calendar_event_deliveries" ("user_id", "channel", "status");
CREATE INDEX IF NOT EXISTS "calendar_event_deliveries_event_created_idx" ON "calendar_event_deliveries" ("event_id", "created_at");
