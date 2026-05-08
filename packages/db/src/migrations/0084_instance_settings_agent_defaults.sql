ALTER TABLE "instance_settings" ADD COLUMN "agent_defaults" jsonb DEFAULT '{}'::jsonb NOT NULL;
