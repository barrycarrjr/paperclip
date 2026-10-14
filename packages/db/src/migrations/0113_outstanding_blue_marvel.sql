ALTER TABLE "memories" ADD COLUMN "drive_file_id" text;--> statement-breakpoint
ALTER TABLE "memory_folders" ADD COLUMN "drive_link_mode" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_folders" ADD COLUMN "link_migration" text;