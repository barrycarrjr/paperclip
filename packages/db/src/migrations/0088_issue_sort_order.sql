-- Manual kanban ordering within a column. `sort_order` is a fractional index
-- (double precision) so reorders only need to rewrite the moved row: the new
-- value is the midpoint between the row's two neighbors. Stored per row, but
-- only meaningful within the (company_id, status) group it's read against.
--
-- Backfill spaces existing rows by 1000.0 so there's plenty of room between
-- siblings before any rebalance is needed.

ALTER TABLE "issues"
  ADD COLUMN IF NOT EXISTS "sort_order" double precision NOT NULL DEFAULT 0;

WITH ranked AS (
  SELECT id,
    ROW_NUMBER() OVER (
      PARTITION BY company_id, status
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM issues
)
UPDATE issues i
SET sort_order = r.rn * 1000.0
FROM ranked r
WHERE i.id = r.id;

CREATE INDEX IF NOT EXISTS "issues_company_status_sort_idx"
  ON "issues" (company_id, status, sort_order);
