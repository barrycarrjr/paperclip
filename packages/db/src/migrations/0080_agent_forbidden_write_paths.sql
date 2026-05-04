ALTER TABLE "agents" ADD COLUMN "forbidden_write_paths" jsonb DEFAULT '[]'::jsonb NOT NULL;
