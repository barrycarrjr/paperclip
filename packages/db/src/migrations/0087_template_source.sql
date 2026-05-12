-- Track upstream source for templates imported from a library (e.g. the
-- paperclip-extensions GitHub release). Null = hand-authored locally.
--
-- The shape stored under `source`:
--   {
--     "type":        "paperclip-extensions",
--     "name":        "phone-assistant",
--     "kind":        "agent" | "routine" | "skill",
--     "version":     "v23",                -- release tag at import time
--     "contentHash": "sha256:...",          -- hash of the source file
--     "sourcePath":  "agents/phone-assistant/AGENT.md",
--     "importedAt":  "2026-05-12T...",
--     "bundleName":  "phone-assistant"      -- present if installed via a bundle
--   }
--
-- The host compares `version` + `contentHash` against the latest
-- templates-index.json to surface "Update available" on the templates list.

ALTER TABLE "routine_templates"
  ADD COLUMN IF NOT EXISTS "source" jsonb;

ALTER TABLE "skill_templates"
  ADD COLUMN IF NOT EXISTS "source" jsonb;

ALTER TABLE "agent_templates"
  ADD COLUMN IF NOT EXISTS "source" jsonb;

CREATE INDEX IF NOT EXISTS "routine_templates_source_name_idx"
  ON "routine_templates" ((source->>'name'))
  WHERE source IS NOT NULL;

CREATE INDEX IF NOT EXISTS "skill_templates_source_name_idx"
  ON "skill_templates" ((source->>'name'))
  WHERE source IS NOT NULL;

CREATE INDEX IF NOT EXISTS "agent_templates_source_name_idx"
  ON "agent_templates" ((source->>'name'))
  WHERE source IS NOT NULL;
