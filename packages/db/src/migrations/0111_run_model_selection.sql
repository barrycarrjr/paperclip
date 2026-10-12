-- Which model a run started with, and why: set on the task by hand ('manual'),
-- picked by one of the agent's model selection rules ('rule'), the rules'
-- fallback ('fallback'), or the agent's own model ('agent-default').
-- `model` is NULL when nothing named a model and the adapter used its own.
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "model" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "model_source" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "model_reason" text;
