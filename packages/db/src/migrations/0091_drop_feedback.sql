-- Drop the feedback subsystem. Telemetry was removed earlier; the thumbs-up/
-- thumbs-down vote surface, the consent-data-sharing fields, and the trace
-- export pipeline were the orphaned other half.

DROP TABLE IF EXISTS "feedback_exports";
DROP TABLE IF EXISTS "feedback_votes";

ALTER TABLE "companies"
  DROP COLUMN IF EXISTS "feedback_data_sharing_enabled",
  DROP COLUMN IF EXISTS "feedback_data_sharing_consent_at",
  DROP COLUMN IF EXISTS "feedback_data_sharing_consent_by_user_id",
  DROP COLUMN IF EXISTS "feedback_data_sharing_terms_version";
