import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  applyPendingMigrations,
  inspectMigrations,
  reconcilePendingMigrationHistory,
  splitMigrationStatements,
} from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-db-client-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

async function migrationHash(migrationFile: string): Promise<string> {
  const content = await fs.promises.readFile(
    new URL(`./migrations/${migrationFile}`, import.meta.url),
    "utf8",
  );
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Which arm of applyPendingMigrations handled a pending migration.
 *
 * There are two, and they are easy to confuse because both end with the history
 * row restored and the state reporting upToDate:
 *
 *  - REPAIRED. reconcilePendingMigrationHistory recognised every statement in
 *    the file and found each target object already present, so it just
 *    re-recorded the history row. No SQL ran.
 *  - REPLAYED. It could not vouch for at least one statement, so the whole file
 *    was executed again by the manual applier.
 *
 * Six tests in this file are named "replays migration NNNN safely", and two of
 * them were REPAIRED, not replayed: their SQL never ran, so removing an
 * IF NOT EXISTS guard left them green. Every replay test now states which arm
 * it expects, because that is the assertion that catches this. It also protects
 * the ones that do replay: they only escape the reconciler because they happen
 * to contain a statement shape it cannot parse (a DO $$ block, an ALTER COLUMN,
 * a bulk UPDATE), so teaching it one more shape would silently gut them.
 */
async function migrationsRepairedWithoutReplay(connectionString: string): Promise<string[]> {
  const result = await reconcilePendingMigrationHistory(connectionString);
  return result.repairedMigrations;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("applyPendingMigrations", () => {
  it(
    "applies an inserted earlier migration without replaying later legacy migrations",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const richMagnetoHash = await migrationHash("0030_rich_magneto.sql");

        await sql.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${richMagnetoHash}'`,
        );
        await sql.unsafe(`DROP TABLE "company_logos"`);
      } finally {
        await sql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: ["0030_rich_magneto.sql"],
        reason: "pending-migrations",
      });

      // Replayed: the test dropped company_logos, so the reconciler cannot say 0030 is already applied.
      expect(await migrationsRepairedWithoutReplay(connectionString)).toEqual(
        [],
      );

      await applyPendingMigrations(connectionString);

      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const rows = await verifySql.unsafe<{ table_name: string }[]>(
          `
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name IN ('company_logos', 'execution_workspaces')
            ORDER BY table_name
          `,
        );
        expect(rows.map((row) => row.table_name)).toEqual([
          "company_logos",
          "execution_workspaces",
        ]);
      } finally {
        await verifySql.end();
      }
    },
    20_000,
  );

  it(
    "replays migration 0044 safely when its schema changes already exist",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const illegalToadHash = await migrationHash("0044_illegal_toad.sql");

        await sql.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${illegalToadHash}'`,
        );

        const columns = await sql.unsafe<{ column_name: string }[]>(
          `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'instance_settings'
              AND column_name = 'general'
          `,
        );
        expect(columns).toHaveLength(1);
      } finally {
        await sql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: ["0044_illegal_toad.sql"],
        reason: "pending-migrations",
      });

      // Replayed: 0044 contains DO $$ blocks and a DROP INDEX, which the reconciler cannot read.
      expect(await migrationsRepairedWithoutReplay(connectionString)).toEqual(
        [],
      );

      await applyPendingMigrations(connectionString);

      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");
    },
    20_000,
  );

  /**
   * Not about 0044, despite where it sits and what it used to be called. 0044
   * creates this index, but 0045_workable_shockwave drops it and recreates it
   * as UNIQUE, so at head the uniqueness is 0045's. Measured: making 0044's
   * index non-unique leaves this test green. It is a plain forward-run check on
   * the schema, and it never replays anything.
   */
  it(
    "enforces a unique board_api_keys.key_hash once every migration has run",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        await sql.unsafe(`
          INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at")
          VALUES ('user-1', 'User One', 'user@example.com', true, now(), now())
        `);
        await sql.unsafe(`
          INSERT INTO "board_api_keys" ("id", "user_id", "name", "key_hash", "created_at")
          VALUES ('00000000-0000-0000-0000-000000000001', 'user-1', 'Key One', 'dup-hash', now())
        `);
        await expect(
          sql.unsafe(`
            INSERT INTO "board_api_keys" ("id", "user_id", "name", "key_hash", "created_at")
            VALUES ('00000000-0000-0000-0000-000000000002', 'user-1', 'Key Two', 'dup-hash', now())
          `),
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    },
    20_000,
  );

  it(
    "replays migration 0046 safely when document revision columns already exist",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const smoothSentinelsHash = await migrationHash("0046_smooth_sentinels.sql");

        await sql.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${smoothSentinelsHash}'`,
        );

        const columns = await sql.unsafe<{ column_name: string; is_nullable: string; column_default: string | null }[]>(
          `
            SELECT column_name, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'document_revisions'
              AND column_name IN ('title', 'format')
            ORDER BY column_name
          `,
        );
        expect(columns).toHaveLength(2);
      } finally {
        await sql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: ["0046_smooth_sentinels.sql"],
        reason: "pending-migrations",
      });

      // Replayed: 0046 contains ALTER COLUMN and a bulk UPDATE, which the reconciler cannot read.
      expect(await migrationsRepairedWithoutReplay(connectionString)).toEqual(
        [],
      );

      await applyPendingMigrations(connectionString);

      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const columns = await verifySql.unsafe<{ column_name: string; is_nullable: string; column_default: string | null }[]>(
          `
            SELECT column_name, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'document_revisions'
              AND column_name IN ('title', 'format')
            ORDER BY column_name
          `,
        );
        expect(columns).toEqual([
          expect.objectContaining({
            column_name: "format",
            is_nullable: "NO",
          }),
          expect.objectContaining({
            column_name: "title",
            is_nullable: "YES",
          }),
        ]);
        expect(columns[0]?.column_default).toContain("'markdown'");
      } finally {
        await verifySql.end();
      }
    },
    20_000,
  );

  /**
   * 0047 is the one replay case whose subject was later half-deleted.
   *
   * It shipped two unrelated things: a feedback subsystem, and a
   * created_by_run_id column on document revisions and issue comments. Forty-
   * four migrations later 0091_drop_feedback removed the feedback half, and
   * nobody came back to this test. It went on asserting that the feedback
   * tables were present after a full migration run, so it failed on a
   * precondition that had stopped being true - before ever reaching the replay
   * behaviour it exists to guard.
   *
   * The run columns survive at head, so the replay is still worth testing, and
   * this covers both of the things that replay now does.
   *
   * FIRST, the replay-safety it was always for. Which migrations are
   * outstanding is worked out as a set difference, so removing 0047's history
   * row makes exactly that one migration pending. Its objects still being
   * present is what its IF NOT EXISTS guards have to survive; strip one and
   * this test goes red on the thrown error rather than on an assertion.
   *
   * SECOND, and less comfortable: replaying a migration that a LATER migration
   * deliberately reversed puts back what the later one removed. 0091 is still
   * recorded as applied so it does not run again to clean up, and the migration
   * state then reports itself up to date with a deleted subsystem back in the
   * database. Recorded here rather than left to be discovered.
   *
   * That resurrection is untidy rather than harmful today: no application code
   * reads or writes those tables - outside the two migration files and this
   * test, the only mentions are drizzle's own meta snapshots - the TypeScript
   * schema does not define them, and they come back empty. The consequence
   * that does last is that a backup dumps whatever tables actually exist, so
   * the orphans would ride along into every later backup and restore.
   *
   * The resurrection assertions are a characterisation, NOT a property worth
   * having. If someone teaches the runner to skip a migration that a later
   * applied one reversed, they will fail; that is an improvement, and the right
   * response is to invert them, not to delete them.
   */
  it(
    "replays migration 0047 when its columns already exist, and puts back what 0091 dropped",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const overjoyedGrootHash = await migrationHash("0047_overjoyed_groot.sql");

        await sql.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${overjoyedGrootHash}'`,
        );

        // The half of 0047 still standing: both columns are already in place,
        // which is the "already exists" state the replay has to survive.
        const columns = await sql.unsafe<{ table_name: string }[]>(
          `
            SELECT table_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND column_name = 'created_by_run_id'
              AND table_name IN ('document_revisions', 'issue_comments')
            ORDER BY table_name
          `,
        );
        expect(columns.map((row) => row.table_name)).toEqual([
          "document_revisions",
          "issue_comments",
        ]);

        // The half 0091 took away, checked before the replay rather than
        // assumed. Without this the resurrection assertions further down would
        // pass whether or not anything was resurrected.
        const feedbackTables = await sql.unsafe<{ table_name: string }[]>(
          `
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name IN ('feedback_exports', 'feedback_votes')
          `,
        );
        expect(feedbackTables.map((row) => row.table_name)).toEqual([]);
      } finally {
        await sql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: ["0047_overjoyed_groot.sql"],
        reason: "pending-migrations",
      });

      // Replayed: 0091 removed some of 0047's objects, and 0047 also contains DO $$ blocks.
      expect(await migrationsRepairedWithoutReplay(connectionString)).toEqual(
        [],
      );

      await applyPendingMigrations(connectionString);

      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const constraints = await verifySql.unsafe<{ conname: string }[]>(
          `
            SELECT conname
            FROM pg_constraint
            WHERE conname IN (
              'document_revisions_created_by_run_id_heartbeat_runs_id_fk',
              'issue_comments_created_by_run_id_heartbeat_runs_id_fk'
            )
            ORDER BY conname
          `,
        );
        expect(constraints.map((row) => row.conname)).toEqual([
          "document_revisions_created_by_run_id_heartbeat_runs_id_fk",
          "issue_comments_created_by_run_id_heartbeat_runs_id_fk",
        ]);

        const columns = await verifySql.unsafe<{ table_name: string; data_type: string }[]>(
          `
            SELECT table_name, data_type
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND column_name = 'created_by_run_id'
              AND table_name IN ('document_revisions', 'issue_comments')
            ORDER BY table_name
          `,
        );
        expect(columns).toEqual([
          expect.objectContaining({ table_name: "document_revisions", data_type: "uuid" }),
          expect.objectContaining({ table_name: "issue_comments", data_type: "uuid" }),
        ]);

        // The characterisation. See the note above before "fixing" these.
        const revivedTables = await verifySql.unsafe<{ table_name: string }[]>(
          `
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name IN ('feedback_exports', 'feedback_votes')
            ORDER BY table_name
          `,
        );
        expect(revivedTables.map((row) => row.table_name)).toEqual([
          "feedback_exports",
          "feedback_votes",
        ]);

        const revivedColumns = await verifySql.unsafe<{ column_name: string }[]>(
          `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'companies'
              AND column_name IN (
                'feedback_data_sharing_enabled',
                'feedback_data_sharing_consent_at',
                'feedback_data_sharing_consent_by_user_id',
                'feedback_data_sharing_terms_version'
              )
            ORDER BY column_name
          `,
        );
        expect(revivedColumns.map((row) => row.column_name)).toEqual([
          "feedback_data_sharing_consent_at",
          "feedback_data_sharing_consent_by_user_id",
          "feedback_data_sharing_enabled",
          "feedback_data_sharing_terms_version",
        ]);
      } finally {
        await verifySql.end();
      }
    },
    20_000,
  );

  /**
   * NOT a replay. 0048 is a single ALTER TABLE ADD COLUMN, which the reconciler
   * recognises, so it re-records the history row and the SQL never runs. This
   * test was called "replays migration 0048 safely" and proved no such thing:
   * with the IF NOT EXISTS removed from 0048 it still passed. The guard itself
   * is covered by the replay-safety test at the end of this file.
   */
  it(
    "records 0048 as applied without re-running it, because routines.variables is already there",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const flashyMarrowHash = await migrationHash("0048_flashy_marrow.sql");

        await sql.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${flashyMarrowHash}'`,
        );

        const columns = await sql.unsafe<{ column_name: string }[]>(
          `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'routines'
              AND column_name = 'variables'
          `,
        );
        expect(columns).toHaveLength(1);
      } finally {
        await sql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: ["0048_flashy_marrow.sql"],
        reason: "pending-migrations",
      });

      // Repaired, NOT replayed: one recognised ADD COLUMN whose column is present.
      expect(await migrationsRepairedWithoutReplay(connectionString)).toEqual(
        ["0048_flashy_marrow.sql"],
      );

      await applyPendingMigrations(connectionString);

      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const columns = await verifySql.unsafe<{ column_name: string; is_nullable: string; data_type: string }[]>(
          `
            SELECT column_name, is_nullable, data_type
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'routines'
              AND column_name = 'variables'
          `,
        );
        expect(columns).toEqual([
          expect.objectContaining({
            column_name: "variables",
            is_nullable: "NO",
            data_type: "jsonb",
          }),
        ]);
      } finally {
        await verifySql.end();
      }
    },
    20_000,
  );

  /**
   * Same shape as 0048 above, and same correction: repaired from schema state,
   * never replayed. Removing 0050's IF NOT EXISTS left this green, which is how
   * the whole class was found.
   */
  it(
    "records 0050 as applied without re-running it, because projects.env is already there",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const stiffLuckmanHash = await migrationHash("0050_stiff_luckman.sql");

        await sql.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${stiffLuckmanHash}'`,
        );

        const columns = await sql.unsafe<{ column_name: string }[]>(
          `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'projects'
              AND column_name = 'env'
          `,
        );
        expect(columns).toHaveLength(1);
      } finally {
        await sql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: ["0050_stiff_luckman.sql"],
        reason: "pending-migrations",
      });

      // Repaired, NOT replayed: one recognised ADD COLUMN whose column is present.
      expect(await migrationsRepairedWithoutReplay(connectionString)).toEqual(
        ["0050_stiff_luckman.sql"],
      );

      await applyPendingMigrations(connectionString);

      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const columns = await verifySql.unsafe<{ column_name: string; is_nullable: string; data_type: string }[]>(
          `
            SELECT column_name, is_nullable, data_type
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'projects'
              AND column_name = 'env'
          `,
        );
        expect(columns).toEqual([
          expect.objectContaining({
            column_name: "env",
            is_nullable: "YES",
            data_type: "jsonb",
          }),
        ]);
      } finally {
        await verifySql.end();
      }
    },
    20_000,
  );

  it(
    "replays migration 0059 safely when plugin_database_namespaces already exists",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const pluginNamespacesHash = await migrationHash(
          "0059_plugin_database_namespaces.sql",
        );

        await sql.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${pluginNamespacesHash}'`,
        );

        const tables = await sql.unsafe<{ table_name: string }[]>(
          `
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name IN ('plugin_database_namespaces', 'plugin_migrations')
            ORDER BY table_name
          `,
        );
        expect(tables.map((row) => row.table_name)).toEqual([
          "plugin_database_namespaces",
          "plugin_migrations",
        ]);
      } finally {
        await sql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: ["0059_plugin_database_namespaces.sql"],
        reason: "pending-migrations",
      });

      // Replayed: 0059's two DO $$ foreign-key blocks are unreadable to the reconciler.
      expect(await migrationsRepairedWithoutReplay(connectionString)).toEqual(
        [],
      );

      await applyPendingMigrations(connectionString);

      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const indexes = await verifySql.unsafe<{ indexname: string }[]>(
          `
            SELECT indexname
            FROM pg_indexes
            WHERE schemaname = 'public'
              AND tablename IN ('plugin_database_namespaces', 'plugin_migrations')
            ORDER BY indexname
          `,
        );
        expect(indexes.map((row) => row.indexname)).toEqual(
          expect.arrayContaining([
            "plugin_database_namespaces_namespace_idx",
            "plugin_database_namespaces_plugin_idx",
            "plugin_database_namespaces_status_idx",
            "plugin_migrations_plugin_idx",
            "plugin_migrations_plugin_key_idx",
            "plugin_migrations_status_idx",
          ]),
        );
      } finally {
        await verifySql.end();
      }
    },
    20_000,
  );
});

/**
 * The guards themselves, tested where they actually bite.
 *
 * A migration file that has been EDITED after shipping reappears as pending on
 * every database that already applied the old text, because which migrations
 * count as applied is decided by hashing the current file contents. So its SQL
 * can be run again against a database that already has its objects, and every
 * `IF NOT EXISTS` in these files exists to survive exactly that.
 *
 * The tests above cannot check this, and it took a while to see why. Going
 * through applyPendingMigrations, the reconciler steps in first: if it can read
 * every statement and finds the objects present, it re-records the history row
 * and the SQL never runs, so a missing guard is invisible. Dropping the object
 * first does not help either - it was measured, and an unguarded ADD COLUMN
 * passes just as happily once the column is gone, because dropping it destroys
 * the very condition the guard exists to survive.
 *
 * What does work is running the statements against a database that still has
 * everything, which is precisely what a real replay does. Measured both ways:
 * green with the guards, and red with 42701 "column already exists" when one is
 * removed.
 *
 * The list is explicit and short because replay-safety is not a property of all
 * 94 migrations and cannot be. Migration 0003 alone would fail on its first
 * statement, and 55 of the 94 carry no guards at all. These are the files
 * someone has had to go back and make re-runnable, each after it actually broke.
 */
const REPLAY_SAFE_MIGRATIONS = [
  // Made idempotent in 01b6b7e6 after a rebase left it half-applied.
  "0044_illegal_toad.sql",
  // Made replay-safe in 90889c12, same day it merged.
  "0046_smooth_sentinels.sql",
  // Made replay-safe in 29d0e82d, "after rebase".
  "0047_overjoyed_groot.sql",
  // Guarded from the start; nothing else can reach these two, because the
  // reconciler always vouches for them and their SQL never replays today.
  "0048_flashy_marrow.sql",
  "0050_stiff_luckman.sql",
  "0059_plugin_database_namespaces.sql",
] as const;

describeEmbeddedPostgres("migration replay safety", () => {
  it(
    "re-runs every migration that claims to be replay-safe against a database that already has its objects",
    async () => {
      const connectionString = await createTempDatabase();
      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      const failures: string[] = [];
      try {
        for (const migration of REPLAY_SAFE_MIGRATIONS) {
          const content = await fs.promises.readFile(
            new URL(`./migrations/${migration}`, import.meta.url),
            "utf8",
          );
          // Rolled back so each file is judged against head rather than
          // against whatever the previous one in the list left behind. Some of
          // these really do change things on replay: 0044 drops and recreates
          // an index, 0046 re-runs a bulk UPDATE.
          try {
            await sql.begin(async (tx) => {
              for (const statement of splitMigrationStatements(content)) {
                await tx.unsafe(statement);
              }
              throw new RollbackAfterReplay();
            });
          } catch (error) {
            if (error instanceof RollbackAfterReplay) continue;
            failures.push(
              `${migration}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      } finally {
        await sql.end();
      }

      // Reported together: one missing guard should not hide the next.
      expect(failures).toEqual([]);
    },
    60_000,
  );
});

/** Thrown to unwind a replay that succeeded, since the point is only that it did. */
class RollbackAfterReplay extends Error {}
