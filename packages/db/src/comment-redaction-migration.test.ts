import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { describe, expect, it } from "vitest";
import { splitMigrationStatements } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const migrations = fileURLToPath(new URL("./migrations", import.meta.url));
const journal = JSON.parse(fs.readFileSync(path.join(migrations, "meta/_journal.json"), "utf8"));
const readSnapshot = (number: string) => JSON.parse(fs.readFileSync(path.join(migrations, `meta/${number}_snapshot.json`), "utf8"));
const manualTag = "0123_outstanding_tiger_shark";

it("appends manual redaction after the deployed wakeup index without changing its snapshot", () => {
  const previous = readSnapshot("0121");
  const master = readSnapshot("0122");
  const manual = readSnapshot("0123");
  expect(master.prevId).toBe(previous.id);
  expect(manual.prevId).toBe(master.id);
  expect(new Set([previous.id, master.id, manual.id]).size).toBe(3);
  const masterEntry = journal.entries.find((entry: { idx: number }) => entry.idx === 122);
  const manualEntry = journal.entries.find((entry: { idx: number }) => entry.idx === 123);
  expect([masterEntry?.tag, manualEntry?.tag]).toEqual(["0122_heartbeat_runs_wakeup_request_idx", manualTag]);
  expect(journal.entries.indexOf(manualEntry)).toBe(journal.entries.indexOf(masterEntry) + 1);
  expect(manualEntry.when).toBeGreaterThan(masterEntry.when);
  expect(master.tables["public.comment_redaction_authorizations"]).toBeUndefined();
  expect(master.tables["public.heartbeat_runs"].indexes.heartbeat_runs_wakeup_request_idx.columns).toMatchObject([
    { expression: "wakeup_request_id" },
  ]);
  const { "public.comment_redaction_authorizations": authorization, ...unchanged } = manual.tables;
  expect(authorization).toBeDefined();
  expect({ ...manual, id: master.id, prevId: master.prevId, tables: unchanged }).toEqual(master);
});

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping redaction migration integration: ${support.reason}`);

describeDb("manual redaction forward migration", () => {
  it("upgrades 0121 through master 0122 and retries partially installed 0123 with its canonical constraints", async () => {
    const cluster = await startEmbeddedPostgresTestDatabase("paperclip-redaction-forward-");
    const admin = postgres(cluster.connectionString, { max: 1, onnotice: () => {} });
    let sql: ReturnType<typeof postgres> | undefined;
    try {
      await admin.unsafe('CREATE DATABASE "redaction_forward"');
      const target = new URL(cluster.connectionString);
      target.pathname = "/redaction_forward";
      sql = postgres(target.href, { max: 1, onnotice: () => {} });
      const db = drizzle(sql);
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "redaction-forward-migrations-"));
      fs.mkdirSync(path.join(fixture, "meta"));
      for (const entry of journal.entries) fs.copyFileSync(path.join(migrations, `${entry.tag}.sql`), path.join(fixture, `${entry.tag}.sql`));
      const advance = async (last: number) => {
        fs.writeFileSync(path.join(fixture, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.filter((entry: { idx: number }) => entry.idx <= last) }));
        await migrate(db, { migrationsFolder: fixture });
      };
      const exists = async (name: string) => (await sql!`select to_regclass(${`public.${name}`})::text as name`)[0]!.name;
      await advance(121);
      expect(await exists("heartbeat_runs_wakeup_request_idx")).toBeNull();
      expect(await exists("comment_redaction_authorizations")).toBeNull();
      await advance(122);
      expect(await exists("heartbeat_runs_wakeup_request_idx")).toBe("heartbeat_runs_wakeup_request_idx");
      expect(await exists("comment_redaction_authorizations")).toBeNull();

      const statements = splitMigrationStatements(fs.readFileSync(path.join(migrations, `${manualTag}.sql`), "utf8"));
      // Simulate an interrupted non-transactional installation before its history row.
      for (const statement of statements.slice(0, 2)) await sql.unsafe(statement);
      await advance(123);
      for (let retry = 0; retry < 2; retry++) for (const statement of statements) await sql.unsafe(statement);
      await advance(123);

      const snapshot = readSnapshot("0123").tables["public.comment_redaction_authorizations"];
      const columns = await sql<{ column_name: string; is_nullable: string; data_type: string; column_default: string | null }[]>`
        select column_name, is_nullable, data_type, column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'comment_redaction_authorizations' order by ordinal_position`;
      expect(columns.map((column) => [column.column_name, column.is_nullable, column.data_type, column.column_default])).toEqual(
        Object.values(snapshot.columns).map((column: any) => [column.name, column.notNull ? "NO" : "YES", column.type, column.default === undefined ? null : String(column.default)]),
      );
      const primaryKeys = await sql<{ definition: string }[]>`
        select pg_get_constraintdef(oid) as definition from pg_constraint
        where conrelid = 'public.comment_redaction_authorizations'::regclass and contype = 'p'`;
      expect(primaryKeys.map((key) => key.definition)).toEqual(["PRIMARY KEY (id)"]);
      const constraints = await sql<{ conname: string; confdeltype: string; confupdtype: string; referenced: string; definition: string }[]>`
        select conname, confdeltype, confupdtype, confrelid::regclass::text as referenced, pg_get_constraintdef(oid) as definition
        from pg_constraint where conrelid = 'public.comment_redaction_authorizations'::regclass and contype = 'f' order by conname`;
      // PostgreSQL stores at most 63 bytes of an identifier (these names are ASCII).
      const foreignKeys = Object.values(snapshot.foreignKeys).map((fk: any) => ({ ...fk, name: fk.name.slice(0, 63) })).sort((a, b) => a.name.localeCompare(b.name));
      expect(constraints.map((constraint) => [constraint.conname, constraint.confdeltype, constraint.confupdtype, constraint.referenced])).toEqual(
        foreignKeys.map((fk) => [fk.name, fk.onDelete === "cascade" ? "c" : "a", "a", fk.tableTo]),
      );
      for (const constraint of constraints) {
        const fk = foreignKeys.find((fk) => fk.name === constraint.conname)!;
        expect(constraint.definition).toContain(`FOREIGN KEY (${fk.columnsFrom.join(", ")}) REFERENCES ${fk.tableTo}(${fk.columnsTo.join(", ")})`);
      }
      const indexes = await sql<{ indexname: string; indexdef: string }[]>`
        select indexname, indexdef from pg_indexes where schemaname = 'public'
        and indexname in ('heartbeat_runs_wakeup_request_idx', 'comment_redaction_authorizations_company_issue_idx') order by indexname`;
      expect(indexes.map((index) => index.indexname)).toEqual([
        "comment_redaction_authorizations_company_issue_idx", "heartbeat_runs_wakeup_request_idx",
      ]);
      expect(indexes[0]!.indexdef).toContain("USING btree (company_id, issue_id)");
      expect(indexes[1]!.indexdef).toContain("USING btree (wakeup_request_id)");
      const history = await sql<{ created_at: string }[]>`select created_at from drizzle.__drizzle_migrations order by id`;
      expect(history.map((row) => Number(row.created_at))).toEqual(journal.entries.filter((entry: { idx: number }) => entry.idx <= 123).map((entry: { when: number }) => entry.when));
    } finally {
      await sql?.end();
      await admin.end();
      await cluster.cleanup();
    }
  }, 90_000);
});
