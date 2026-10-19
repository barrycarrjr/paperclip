CREATE TABLE IF NOT EXISTS "comment_redaction_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"comment_id" uuid NOT NULL,
	"instruction_comment_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"requested_by_user_id" text NOT NULL,
	"requested_by_local_board" boolean DEFAULT false NOT NULL,
	"body_digest" text NOT NULL,
	"ranges" jsonb NOT NULL,
	"keep_last4" boolean NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'comment_redaction_authorizations_company_id_companies_id_fk' AND conrelid = 'public.comment_redaction_authorizations'::regclass) THEN
    ALTER TABLE "comment_redaction_authorizations" ADD CONSTRAINT "comment_redaction_authorizations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'comment_redaction_authorizations_issue_id_issues_id_fk' AND conrelid = 'public.comment_redaction_authorizations'::regclass) THEN
    ALTER TABLE "comment_redaction_authorizations" ADD CONSTRAINT "comment_redaction_authorizations_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'comment_redaction_authorizations_comment_id_issue_comments_id_fk' AND conrelid = 'public.comment_redaction_authorizations'::regclass) THEN
    ALTER TABLE "comment_redaction_authorizations" ADD CONSTRAINT "comment_redaction_authorizations_comment_id_issue_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'comment_redaction_authorizations_instruction_comment_id_issue_comments_id_fk' AND conrelid = 'public.comment_redaction_authorizations'::regclass) THEN
    ALTER TABLE "comment_redaction_authorizations" ADD CONSTRAINT "comment_redaction_authorizations_instruction_comment_id_issue_comments_id_fk" FOREIGN KEY ("instruction_comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'comment_redaction_authorizations_agent_id_agents_id_fk' AND conrelid = 'public.comment_redaction_authorizations'::regclass) THEN
    ALTER TABLE "comment_redaction_authorizations" ADD CONSTRAINT "comment_redaction_authorizations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comment_redaction_authorizations_company_issue_idx" ON "comment_redaction_authorizations" USING btree ("company_id","issue_id");