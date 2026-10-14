CREATE TABLE "issue_terminal_events" (
	"issue_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"processed_version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_terminal_events" ADD CONSTRAINT "issue_terminal_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_terminal_events" ADD CONSTRAINT "issue_terminal_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_terminal_events_company_idx" ON "issue_terminal_events" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "agent_wakeup_requests_idempotency_idx" ON "agent_wakeup_requests" USING btree ("company_id","agent_id","idempotency_key");
--> statement-breakpoint
CREATE FUNCTION paperclip_record_issue_terminal_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('done', 'cancelled') AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    INSERT INTO issue_terminal_events (issue_id, company_id, version, processed_version)
      VALUES (NEW.id, NEW.company_id, 1, 0)
      ON CONFLICT (issue_id) DO UPDATE SET version = issue_terminal_events.version + 1;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER paperclip_issue_terminal_event AFTER INSERT OR UPDATE OF status ON issues
  FOR EACH ROW EXECUTE FUNCTION paperclip_record_issue_terminal_event();
--> statement-breakpoint
INSERT INTO issue_terminal_events (issue_id, company_id)
  SELECT id, company_id FROM issues WHERE status IN ('done', 'cancelled');
