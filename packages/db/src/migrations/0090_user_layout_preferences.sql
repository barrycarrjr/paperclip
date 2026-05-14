-- Per-user layout preferences for the Portfolio sidebar nav and per-page
-- section order. Both are JSONB ordered-id lists, mirroring `company_order`.
--
-- `portfolio_nav_order`  : string[] of nav slugs (e.g. "portfolio-brief")
-- `page_section_orders`  : { [pageKey]: string[] } of section slugs
--                          (e.g. { "portfolio-brief": ["companies","awaiting-tap",...] })
--
-- Defaults are empty; the UI falls back to its hardcoded default order
-- whenever the saved list is empty or missing entries.

ALTER TABLE "user_sidebar_preferences"
  ADD COLUMN IF NOT EXISTS "portfolio_nav_order" jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "user_sidebar_preferences"
  ADD COLUMN IF NOT EXISTS "page_section_orders" jsonb NOT NULL DEFAULT '{}'::jsonb;
