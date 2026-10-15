CREATE TABLE "instruction_rule_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"approval_id" uuid NOT NULL,
	"source_issue_id" uuid,
	"source_comment_id" uuid,
	"target_agent_id" uuid,
	"scope" text NOT NULL,
	"rule" text NOT NULL,
	"rationale" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN "intent" text DEFAULT 'message' NOT NULL;--> statement-breakpoint
ALTER TABLE "instruction_rule_proposals" ADD CONSTRAINT "instruction_rule_proposals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instruction_rule_proposals" ADD CONSTRAINT "instruction_rule_proposals_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instruction_rule_proposals" ADD CONSTRAINT "instruction_rule_proposals_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instruction_rule_proposals" ADD CONSTRAINT "instruction_rule_proposals_source_comment_id_issue_comments_id_fk" FOREIGN KEY ("source_comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instruction_rule_proposals" ADD CONSTRAINT "instruction_rule_proposals_target_agent_id_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "instruction_rule_proposals_approval_unique" ON "instruction_rule_proposals" USING btree ("approval_id");--> statement-breakpoint
CREATE UNIQUE INDEX "instruction_rule_proposals_source_agent_unique" ON "instruction_rule_proposals" USING btree ("source_comment_id","target_agent_id");--> statement-breakpoint
CREATE INDEX "instruction_rule_proposals_company_scope_idx" ON "instruction_rule_proposals" USING btree ("company_id","scope");--> statement-breakpoint
CREATE INDEX "instruction_rule_proposals_target_agent_idx" ON "instruction_rule_proposals" USING btree ("target_agent_id");