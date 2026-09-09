-- Workspaces a person has pinned to their sidebar (P1's "Pinned tools" and
-- the pinning half of "All workspaces" in the scope document).
--
-- Additive and defaulted, so existing rows keep working with no pins and the
-- feature rolls back by dropping one column. Per user, not per company: a pin
-- says "this is a tool I use", which does not change per company.
ALTER TABLE "user_sidebar_preferences"
  ADD COLUMN IF NOT EXISTS "pinned_workspaces" jsonb NOT NULL DEFAULT '[]'::jsonb;
