CREATE TABLE IF NOT EXISTS "memories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "agent_id" uuid REFERENCES "agents"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "content" text NOT NULL,
  "created_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "created_by_user_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "memories_company_idx" ON "memories" ("company_id");
CREATE INDEX IF NOT EXISTS "memories_company_kind_idx" ON "memories" ("company_id", "kind");
CREATE INDEX IF NOT EXISTS "memories_company_agent_idx" ON "memories" ("company_id", "agent_id");
CREATE UNIQUE INDEX IF NOT EXISTS "memories_company_agent_name_uq" ON "memories" ("company_id", "agent_id", "name");
