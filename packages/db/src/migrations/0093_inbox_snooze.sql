-- Snooze an attention row: put it away and have it come back on its own.
--
-- It rides on inbox_dismissals rather than a new table because it is the same
-- decision about the same thing ("not now") keyed the same way, and one row
-- per (company, user, item) keeps the queue's lookup a single map.
--
-- Snooze and dismiss are separate columns on purpose. They answer different
-- questions and expire differently: a dismissal lapses the moment the item
-- changes, while a snooze holds until its time is up whatever happens to the
-- item, because "not until tomorrow" should survive somebody editing a field.

ALTER TABLE "inbox_dismissals"
  ADD COLUMN IF NOT EXISTS "snoozed_until" timestamp with time zone;

-- The queue asks "is this snoozed right now" for every row on every request,
-- so the partial index only carries rows that are actually snoozed.
CREATE INDEX IF NOT EXISTS "inbox_dismissals_snoozed_until_idx"
  ON "inbox_dismissals" ("company_id", "user_id", "snoozed_until")
  WHERE "snoozed_until" IS NOT NULL;
