ALTER TABLE "agents" ADD COLUMN "default_reviewer_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "execution_policy_explicit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "issues" SET "execution_policy_explicit" = true WHERE "execution_policy" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_default_reviewer_agent_id_agents_id_fk" FOREIGN KEY ("default_reviewer_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_company_default_reviewer_idx" ON "agents" USING btree ("company_id","default_reviewer_agent_id");
