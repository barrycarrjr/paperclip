/**
 * Get a throwaway migrated database for a test file.
 *
 * Two ways, in order:
 *
 * 1. `PAPERCLIP_TEST_POSTGRES_URL` — an existing server to create a throwaway
 *    database on. Fast, and the only option that works on a machine where
 *    spawning a fresh cluster is slow or blocked (real-time virus scanning
 *    watching `initdb` write a few thousand files is the usual reason).
 * 2. Otherwise, a fresh embedded cluster, as before.
 *
 * Either way the caller gets its own database with migrations applied, and
 * dropping it on cleanup, so no test can see another's rows. Nothing here ever
 * touches a database that already existed: option 1 creates one with a random
 * name and drops that.
 *
 * The URL points at any database on the target server (`postgres` is the usual
 * choice); only its host, port and credentials are used.
 */

import { randomUUID } from "node:crypto";
import {
  applyPendingMigrations,
  ensurePostgresDatabase,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";

export interface TestDatabase {
  connectionString: string;
  cleanup(): Promise<void>;
}

export interface TestDatabaseSupport {
  supported: boolean;
  reason?: string;
}

function externalServerUrl(): string | null {
  const raw = process.env.PAPERCLIP_TEST_POSTGRES_URL?.trim();
  return raw && raw.length > 0 ? raw : null;
}

/**
 * Whether a database is available at all, so a suite can skip rather than fail
 * on a machine that has neither.
 */
export async function getTestDatabaseSupport(): Promise<TestDatabaseSupport> {
  if (externalServerUrl()) return { supported: true };
  return getEmbeddedPostgresTestSupport();
}

export async function startTestDatabase(tempDirPrefix: string): Promise<TestDatabase> {
  const external = externalServerUrl();
  if (!external) {
    return startEmbeddedPostgresTestDatabase(tempDirPrefix);
  }

  const base = new URL(external);
  // A fresh name per call. Postgres lowercases unquoted identifiers and
  // rejects a leading digit, so the uuid is prefixed and hyphens stripped.
  const dbName = `pctest_${randomUUID().replace(/-/g, "")}`;

  const adminUrl = new URL(base.toString());
  adminUrl.pathname = "/postgres";

  await ensurePostgresDatabase(adminUrl.toString(), dbName);

  const target = new URL(base.toString());
  target.pathname = `/${dbName}`;
  const connectionString = target.toString();

  await applyPendingMigrations(connectionString);

  return {
    connectionString,
    cleanup: async () => {
      // Import lazily: `postgres` is only needed on this path, and pulling it
      // in at module load would cost every suite that uses the embedded route.
      const { default: postgres } = await import("postgres");
      const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
      try {
        // Anything still connected would block the drop. Nothing should be, but
        // a leaked pool in a failing test would otherwise turn one red test
        // into a hung suite.
        await admin.unsafe(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}'`,
        );
        await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
      } finally {
        await admin.end({ timeout: 5 });
      }
    },
  };
}
