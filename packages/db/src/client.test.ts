import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  applyPendingMigrations,
  inspectMigrations,
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

      await applyPendingMigrations(connectionString);

      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");
    },
    20_000,
  );

  it(
    "enforces a unique board_api_keys.key_hash after migration 0044",
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

  it(
    "replays migration 0048 safely when routines.variables already exists",
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

  it(
    "replays migration 0050 safely when projects.env already exists",
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
