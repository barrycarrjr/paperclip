DROP INDEX "plugin_entities_external_idx";--> statement-breakpoint
ALTER TABLE "plugin_entities" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "plugin_job_runs" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "plugin_logs" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "plugin_webhook_deliveries" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "plugin_entities" ADD CONSTRAINT "plugin_entities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_job_runs" ADD CONSTRAINT "plugin_job_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_logs" ADD CONSTRAINT "plugin_logs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_webhook_deliveries" ADD CONSTRAINT "plugin_webhook_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plugin_entities_company_idx" ON "plugin_entities" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "plugin_job_runs_company_idx" ON "plugin_job_runs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "plugin_logs_company_idx" ON "plugin_logs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "plugin_webhook_deliveries_company_idx" ON "plugin_webhook_deliveries" USING btree ("company_id");--> statement-breakpoint
UPDATE "plugin_entities" e SET "company_id" = c."id" FROM "companies" c WHERE e."scope_kind" = 'company' AND e."scope_id" = c."id"::text;--> statement-breakpoint
UPDATE "plugin_entities" e SET "company_id" = c."company_id" FROM "projects" c WHERE e."scope_kind" = 'project' AND e."scope_id" = c."id"::text;--> statement-breakpoint
UPDATE "plugin_entities" e SET "company_id" = c."company_id" FROM "project_workspaces" c WHERE e."scope_kind" = 'project_workspace' AND e."scope_id" = c."id"::text;--> statement-breakpoint
UPDATE "plugin_entities" e SET "company_id" = c."company_id" FROM "agents" c WHERE e."scope_kind" = 'agent' AND e."scope_id" = c."id"::text;--> statement-breakpoint
UPDATE "plugin_entities" e SET "company_id" = c."company_id" FROM "issues" c WHERE e."scope_kind" = 'issue' AND e."scope_id" = c."id"::text;--> statement-breakpoint
UPDATE "plugin_entities" e SET "company_id" = c."company_id" FROM "goals" c WHERE e."scope_kind" = 'goal' AND e."scope_id" = c."id"::text;--> statement-breakpoint
UPDATE "plugin_entities" e SET "company_id" = c."company_id" FROM "heartbeat_runs" c WHERE e."scope_kind" = 'run' AND e."scope_id" = c."id"::text;--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_entities_external_idx" ON "plugin_entities" ("company_id","plugin_id","entity_type","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_entities_instance_external_idx" ON "plugin_entities" ("plugin_id","entity_type","external_id") WHERE "company_id" IS NULL;
