-- Operator control over who may run each plugin operation.
-- A plugin's manifest says who an operation is FOR; this column is how the
-- operator narrows that for their own install: switch an operation off, hide
-- it from agents, or require a human yes before an agent runs it.
-- It can only ever narrow. A manifest that says "users only" cannot be turned
-- into an agent tool by config, so installing a plugin never grants agents
-- something its author did not publish to them.
-- Additive only: one nullable-by-default column, so rolling back is dropping
-- the column.
ALTER TABLE "plugins"
  ADD COLUMN IF NOT EXISTS "operation_policy_json" jsonb NOT NULL DEFAULT '{}'::jsonb;
