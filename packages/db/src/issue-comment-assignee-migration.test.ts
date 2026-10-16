import fs from "node:fs";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { splitMigrationStatements } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue comment assignee migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function migrationStatements(): Promise<string[]> {
  const content = await fs.promises.readFile(
    new URL("./migrations/0121_awesome_wolf_cub.sql", import.meta.url),
    "utf8",
  );
  return splitMigrationStatements(content);
}

describeEmbeddedPostgres("migration 0121, correction target", () => {
  it(
    "backfills a unique proposal target and leaves conflicting targets unassigned",
    async () => {
      const testDb = await startEmbeddedPostgresTestDatabase("paperclip-comment-target-migration-");
      cleanups.push(testDb.cleanup);
      const sql = postgres(testDb.connectionString, { max: 1, onnotice: () => {} });
      cleanups.push(async () => {
        await sql.end();
      });

      const [{ id: companyId }] = await sql<Array<{ id: string }>>`
        SELECT "id" FROM "companies" ORDER BY "created_at" LIMIT 1
      `;
      const [firstAgent, secondAgent] = await sql<Array<{ id: string }>>`
        INSERT INTO "agents" ("company_id", "name")
        VALUES (${companyId}, 'First migration agent'), (${companyId}, 'Second migration agent')
        RETURNING "id"
      `;
      const [{ id: issueId }] = await sql<Array<{ id: string }>>`
        INSERT INTO "issues" ("company_id", "title")
        VALUES (${companyId}, 'Migration fixture')
        RETURNING "id"
      `;
      const comments = await sql<Array<{ id: string; body: string }>>`
        INSERT INTO "issue_comments" ("company_id", "issue_id", "intent", "body")
        VALUES
          (${companyId}, ${issueId}, 'correction', 'unique'),
          (${companyId}, ${issueId}, 'correction', 'conflicting'),
          (${companyId}, ${issueId}, 'message', 'ordinary')
        RETURNING "id", "body"
      `;
      const commentByBody = Object.fromEntries(comments.map((comment) => [comment.body, comment.id]));
      const approvals = await sql<Array<{ id: string }>>`
        INSERT INTO "approvals" ("company_id", "type", "payload")
        VALUES
          (${companyId}, 'instruction_rule', '{}'::jsonb),
          (${companyId}, 'instruction_rule', '{}'::jsonb),
          (${companyId}, 'instruction_rule', '{}'::jsonb),
          (${companyId}, 'instruction_rule', '{}'::jsonb)
        RETURNING "id"
      `;
      await sql`
        INSERT INTO "instruction_rule_proposals"
          ("company_id", "approval_id", "source_issue_id", "source_comment_id", "target_agent_id", "scope", "rule")
        VALUES
          (${companyId}, ${approvals[0]!.id}, ${issueId}, ${commentByBody.unique}, ${firstAgent!.id}, 'agent', 'unique'),
          (${companyId}, ${approvals[1]!.id}, ${issueId}, ${commentByBody.conflicting}, ${firstAgent!.id}, 'agent', 'first'),
          (${companyId}, ${approvals[2]!.id}, ${issueId}, ${commentByBody.conflicting}, ${secondAgent!.id}, 'agent', 'second'),
          (${companyId}, ${approvals[3]!.id}, ${issueId}, ${commentByBody.ordinary}, ${firstAgent!.id}, 'agent', 'ordinary')
      `;
      await sql`
        INSERT INTO "agent_wakeup_requests"
          ("company_id", "agent_id", "source", "reason", "payload", "idempotency_key")
        VALUES (
          ${companyId},
          ${secondAgent!.id},
          'automation',
          'issue_comment_mentioned',
          ${sql.json({ issueId, commentId: commentByBody.unique })},
          ${`issue-comment:${commentByBody.unique}:mention:${secondAgent!.id}`}
        )
      `;

      await sql.unsafe(
        `ALTER TABLE "issue_comments" DROP COLUMN "expected_assignee_agent_id"`,
      );
      await sql.unsafe(
        `ALTER TABLE "issue_comments" DROP COLUMN "correction_recipient_agent_ids"`,
      );
      for (const statement of await migrationStatements()) await sql.unsafe(statement);

      const results = await sql<Array<{
        body: string;
        expected_assignee_agent_id: string | null;
        correction_recipient_agent_ids: string[] | null;
      }>>`
        SELECT "body", "expected_assignee_agent_id", "correction_recipient_agent_ids"
        FROM "issue_comments"
        WHERE "id" IN (${commentByBody.unique}, ${commentByBody.conflicting}, ${commentByBody.ordinary})
        ORDER BY "body"
      `;
      expect(Object.fromEntries(results.map((row) => [row.body, row.expected_assignee_agent_id]))).toEqual({
        conflicting: null,
        ordinary: null,
        unique: firstAgent!.id,
      });
      expect(results.find((row) => row.body === "unique")?.correction_recipient_agent_ids).toEqual(
        [firstAgent!.id, secondAgent!.id].sort(),
      );
      expect(results.find((row) => row.body === "conflicting")?.correction_recipient_agent_ids).toBeNull();

      await sql`DELETE FROM "agents" WHERE "id" = ${firstAgent!.id}`;
      const [retained] = await sql<Array<{ expected_assignee_agent_id: string | null }>>`
        SELECT "expected_assignee_agent_id"
        FROM "issue_comments"
        WHERE "id" = ${commentByBody.unique}
      `;
      expect(retained?.expected_assignee_agent_id).toBe(firstAgent!.id);
    },
    90_000,
  );
});
