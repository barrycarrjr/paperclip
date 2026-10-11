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
    `Skipping embedded Postgres account approval migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function migrationStatements(): Promise<string[]> {
  const content = await fs.promises.readFile(
    new URL("./migrations/0110_account_approval.sql", import.meta.url),
    "utf8",
  );
  return splitMigrationStatements(content);
}

/**
 * Migration 0110 adds the approval step for new accounts. Every account that
 * exists when it runs must come out approved, every account made after it
 * must start as a request, and running the file a second time must not
 * approve anybody.
 */
describeEmbeddedPostgres("migration 0110, account approval", () => {
  it(
    "approves the accounts already there, leaves new ones waiting, and approves nobody when run again",
    async () => {
      const testDb = await startEmbeddedPostgresTestDatabase("paperclip-account-approval-migration-");
      cleanups.push(testDb.cleanup);
      const sql = postgres(testDb.connectionString, { max: 1, onnotice: () => {} });
      cleanups.push(async () => {
        await sql.end();
      });

      // Back to how the table looked before 0110, with two people on it.
      await sql.unsafe(`
        ALTER TABLE "user"
          DROP COLUMN "approval_status",
          DROP COLUMN "approval_decided_at",
          DROP COLUMN "approval_decided_by_user_id"
      `);
      await sql.unsafe(`
        INSERT INTO "user" ("id", "name", "email", "created_at", "updated_at")
        VALUES ('existing-1', 'Existing One', 'one@example.com', now(), now()),
               ('existing-2', 'Existing Two', 'two@example.com', now(), now())
      `);

      const statements = await migrationStatements();
      for (const statement of statements) await sql.unsafe(statement);

      // Made after the migration, the way the sign-in library makes one: no
      // status given.
      await sql.unsafe(`
        INSERT INTO "user" ("id", "name", "email", "created_at", "updated_at")
        VALUES ('new-1', 'New One', 'new1@example.com', now(), now()),
               ('new-2', 'New Two', 'new2@example.com', now(), now())
      `);
      await sql.unsafe(`UPDATE "user" SET "approval_status" = 'declined' WHERE "id" = 'new-2'`);

      const statusById = async () =>
        Object.fromEntries(
          (await sql.unsafe<Array<{ id: string; approval_status: string }>>(
            `SELECT "id", "approval_status" FROM "user" ORDER BY "id"`,
          )).map((row) => [row.id, row.approval_status]),
        );

      expect(await statusById()).toEqual({
        "existing-1": "approved",
        "existing-2": "approved",
        "new-1": "pending",
        "new-2": "declined",
      });

      // A second run, as when a migration's history row goes missing.
      for (const statement of statements) await sql.unsafe(statement);

      expect(await statusById()).toEqual({
        "existing-1": "approved",
        "existing-2": "approved",
        "new-1": "pending",
        "new-2": "declined",
      });
    },
    90_000,
  );
});
