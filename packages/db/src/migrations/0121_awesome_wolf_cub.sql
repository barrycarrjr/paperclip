ALTER TABLE "issue_comments" ADD COLUMN "expected_assignee_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN "correction_recipient_agent_ids" jsonb;--> statement-breakpoint
-- Backfill only when an existing proposal proves one immutable target. Legacy
-- corrections without that evidence stay unassigned and must be resubmitted.
UPDATE "issue_comments" AS "comment"
SET "expected_assignee_agent_id" = "target"."target_agent_id"
FROM (
	SELECT
		"source_comment_id",
		(array_agg(DISTINCT "target_agent_id"))[1] AS "target_agent_id"
	FROM "instruction_rule_proposals"
	WHERE "source_comment_id" IS NOT NULL
	  AND "target_agent_id" IS NOT NULL
	GROUP BY "source_comment_id"
	HAVING count(DISTINCT "target_agent_id") = 1
) AS "target"
WHERE "target"."source_comment_id" = "comment"."id"
  AND "comment"."intent" = 'correction'
  AND "comment"."expected_assignee_agent_id" IS NULL;--> statement-breakpoint
-- Preserve every correction recipient that can be proven from immutable
-- historical data. New corrections save the full resolved set before waking.
UPDATE "issue_comments" AS "comment"
SET "correction_recipient_agent_ids" = "recipients"."agent_ids"
FROM (
	SELECT
		"correction"."id" AS "comment_id",
		jsonb_agg("recipient"."agent_id" ORDER BY "recipient"."agent_id") AS "agent_ids"
	FROM "issue_comments" AS "correction"
	CROSS JOIN LATERAL (
		SELECT "correction"."expected_assignee_agent_id" AS "agent_id"
		WHERE "correction"."expected_assignee_agent_id" IS NOT NULL
		UNION
		SELECT "request"."agent_id"
		FROM "agent_wakeup_requests" AS "request"
		WHERE "request"."company_id" = "correction"."company_id"
		  AND EXISTS (
			SELECT 1
			FROM "agents" AS "recipient_agent"
			WHERE "recipient_agent"."id" = "request"."agent_id"
			  AND "recipient_agent"."company_id" = "correction"."company_id"
		  )
		  AND "request"."payload" ->> 'issueId' = "correction"."issue_id"::text
		  AND "request"."payload" ->> 'commentId' = "correction"."id"::text
		  AND (
			"request"."idempotency_key" = 'issue-comment:' || "correction"."id"::text || ':assignee:' || "request"."agent_id"::text
			OR "request"."idempotency_key" = 'issue-comment:' || "correction"."id"::text || ':mention:' || "request"."agent_id"::text
		  )
	) AS "recipient"
	WHERE "correction"."intent" = 'correction'
	  AND "correction"."expected_assignee_agent_id" IS NOT NULL
	GROUP BY "correction"."id"
) AS "recipients"
WHERE "comment"."id" = "recipients"."comment_id";
