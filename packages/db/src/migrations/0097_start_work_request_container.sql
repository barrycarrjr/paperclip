-- One container issue per Start work request (P5b).
--
-- The dialog mints one request key per typed request and the planner writes
-- it to issues.origin_id with origin_kind 'start_work'. This partial unique
-- index makes that key map to exactly one container, so a retried draft
-- (Enter pressed twice, a request killed mid-flight, the same key from two
-- browser tabs or two server processes) can never create two containers.
--
-- Cancelled containers keep the key on purpose: this index ignores status and
-- hidden_at, unlike the recovery indexes in 0070, so a retry after reject
-- returns the rejected plan rather than drafting again.
--
-- Additive only. No start_work rows exist yet, so it cannot fail on existing
-- data, and the feature rolls back by dropping this one index. The name and
-- shape match what drizzle-kit generates for startWorkRequestIdx in
-- packages/db/src/schema/issues.ts, so a future generate sees no difference.
CREATE UNIQUE INDEX IF NOT EXISTS "issues_start_work_request_uq"
  ON "issues" USING btree ("company_id","origin_id")
  WHERE "origin_kind" = 'start_work'
    AND "origin_id" IS NOT NULL;
