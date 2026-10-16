import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  issueRelations,
  issues,
  pluginDatabaseNamespaces,
  pluginMigrations,
  plugins,
} from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  acceptedMigrationChecksums,
  derivePluginDatabaseNamespace,
  migrationChecksum,
  pluginDatabaseService,
  validatePluginMigrationStatement,
  validatePluginRuntimeExecute,
  validatePluginRuntimeQuery,
} from "../services/plugin-database.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plugin database tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("plugin database SQL validation", () => {
  it("allows namespace migrations with whitelisted public foreign keys", () => {
    expect(() =>
      validatePluginMigrationStatement(
        "CREATE TABLE plugin_test.rows (id uuid PRIMARY KEY, issue_id uuid REFERENCES public.issues(id))",
        "plugin_test",
        ["issues"],
      )
    ).not.toThrow();
  });

  it("rejects migrations that create public objects", () => {
    expect(() =>
      validatePluginMigrationStatement(
        "CREATE TABLE public.rows (id uuid PRIMARY KEY)",
        "plugin_test",
        ["issues"],
      )
    ).toThrow(/public/i);
  });

  it("recognizes native type modifiers only in type positions", () => {
    for (const type of [
      "numeric(12,2)", "decimal(12,2)", "varchar(255)", "character varying(255)",
      "char(4)", "character(4)", "bit(4)", "bit varying(4)", "varbit(4)",
      "time(3)", "time(3) with time zone", "timestamp(3)", "timestamp(3) without time zone",
      "interval(3)", "interval day to second(3)", "pg_catalog.numeric(12,2)", '"pg_catalog"."numeric"(12,2)',
    ]) {
      expect(() => validatePluginMigrationStatement(`CREATE TABLE plugin_test.rows (value ${type})`, "plugin_test")).not.toThrow();
      expect(() => validatePluginMigrationStatement(`ALTER TABLE plugin_test.rows ADD COLUMN value ${type}`, "plugin_test")).not.toThrow();
      expect(() => validatePluginMigrationStatement(`ALTER TABLE plugin_test.rows ALTER COLUMN value TYPE ${type} USING value::${type}`, "plugin_test")).not.toThrow();
      expect(() => validatePluginRuntimeQuery(`SELECT $1::${type}`, "plugin_test")).not.toThrow();
      expect(() => validatePluginRuntimeQuery(`SELECT CAST($1 AS ${type})`, "plugin_test")).not.toThrow();
    }
    expect(() => validatePluginRuntimeQuery("SELECT numeric(12,2) '1'", "plugin_test")).not.toThrow();
    expect(() => validatePluginRuntimeQuery(
      "SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(amount numeric(12,2), label varchar(255))", "plugin_test",
    )).not.toThrow();
    for (const statement of [
      "SELECT numeric(12,2)", "SELECT varchar(255)", "SELECT char(4)",
      "SELECT public.numeric(12,2)", "SELECT CAST(1 AS public.numeric(12,2))", "SELECT 1::public.numeric(12,2)",
      "SELECT 1::numeric(pg_read_file('PG_VERSION'),2)", "SELECT CAST(1 AS pg_read_file(1))",
      "SELECT CAST(1 AS numeric(pg_read_file('PG_VERSION'),2))",
    ]) {
      expect(() => validatePluginRuntimeQuery(statement, "plugin_test")).toThrow(/function.*not allowed/i);
    }
    for (const statement of [
      "CREATE TABLE plugin_test.rows (value public.numeric(12,2))",
      "CREATE TABLE plugin_test.rows (value varchar(pg_read_file('PG_VERSION')))",
      "CREATE TABLE plugin_test.rows (value integer DEFAULT numeric(12,2))",
    ]) {
      expect(() => validatePluginMigrationStatement(statement, "plugin_test")).toThrow(/function.*not allowed/i);
    }
  });

  it("allows only built-in PostgreSQL cast and column type targets", () => {
    for (const type of [
      "text", "uuid", "jsonb", "integer", "bigint", "boolean", "date", "timestamptz",
      "text[]", "uuid[][]", "numeric(12,2)[]", "character varying(255)", "timestamp(3) with time zone",
      "pg_catalog.text", '"pg_catalog"."text"', '"text"', "pg_catalog.regclass",
    ]) {
      expect(() => validatePluginRuntimeQuery(`SELECT $1::${type}`, "plugin_test")).not.toThrow();
      expect(() => validatePluginRuntimeQuery(`SELECT CAST($1 AS ${type})`, "plugin_test")).not.toThrow();
      expect(() => validatePluginRuntimeExecute(
        `INSERT INTO plugin_test.rows (value) VALUES ($1::${type})`, "plugin_test",
      )).not.toThrow();
      expect(() => validatePluginMigrationStatement(
        `CREATE TABLE plugin_test.rows (value ${type})`, "plugin_test",
      )).not.toThrow();
      expect(() => validatePluginMigrationStatement(
        `ALTER TABLE plugin_test.rows ADD COLUMN value ${type}`, "plugin_test",
      )).not.toThrow();
    }

    for (const type of [
      "public.audit_domain", "plugin_test.audit_domain", "other_schema.audit_type",
      '"public"."audit_domain"', '"plugin_test"."audit_domain"',
      "audit_domain", '"audit_domain"', '"TEXT"', "pg_catalog.audit_domain", "pg_catalog.text.extra",
      "public.custom_enum[]", "plugin_test.cast_target(12)",
    ]) {
      expect(() => validatePluginRuntimeQuery(`SELECT $1::${type}`, "plugin_test")).toThrow(/type.*(?:not allowed|built-in)/i);
      expect(() => validatePluginRuntimeQuery(`SELECT CAST($1 AS ${type})`, "plugin_test")).toThrow(/type.*(?:not allowed|built-in)/i);
      expect(() => validatePluginRuntimeExecute(
        `INSERT INTO plugin_test.rows (value) VALUES ($1::${type})`, "plugin_test",
      )).toThrow(/type.*(?:not allowed|built-in)/i);
      expect(() => validatePluginMigrationStatement(
        `CREATE TABLE plugin_test.rows (value ${type})`, "plugin_test",
      )).toThrow(/type.*(?:not allowed|built-in)/i);
      expect(() => validatePluginMigrationStatement(
        `ALTER TABLE plugin_test.rows ALTER COLUMN value TYPE ${type} USING value::${type}`, "plugin_test",
      )).toThrow(/type.*(?:not allowed|built-in)/i);
    }

    expect(() => validatePluginRuntimeQuery(
      "SELECT '::public.audit_domain' AS literal /* ::plugin_test.audit_domain */", "plugin_test",
    )).not.toThrow();
    expect(() => validatePluginRuntimeQuery(
      "SELECT $1 /* before */ :: /* schema */ pg_catalog /* dot */ . /* type */ text[]", "plugin_test",
    )).not.toThrow();
    expect(() => validatePluginRuntimeQuery(
      "SELECT CAST($1 AS /* schema */ public /* dot */ . /* domain */ audit_domain[])", "plugin_test",
    )).toThrow(/type.*not allowed/i);
    expect(() => validatePluginRuntimeQuery(
      "SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(value public.audit_domain)", "plugin_test",
    )).toThrow(/type.*not allowed/i);
    expect(() => validatePluginMigrationStatement(
      'CREATE TABLE plugin_test.rows (value "public" /* dot */ . "custom_type"[])', "plugin_test",
    )).toThrow(/type.*not allowed/i);
  });

  it("allows only built-in PostgreSQL typed literal targets", () => {
    for (const expression of [
      "date '2026-10-16'", "time '12:34:56'", "time(3) with time zone '12:34:56+00'",
      "timestamp(3) without time zone '2026-10-16 12:34:56'", "interval '1 day'",
      "interval(3) '1 second'", "interval '1' day to second", "bit '0101'", "bit varying(4) '0101'",
      "pg_catalog.uuid '00000000-0000-0000-0000-000000000000'", '"pg_catalog"."text" \'safe\'',
      "text[] '{safe}'", "numeric(5,2) '12.34'",
    ]) {
      expect(() => validatePluginRuntimeQuery(`SELECT ${expression}`, "plugin_test")).not.toThrow();
      expect(() => validatePluginRuntimeExecute(
        `INSERT INTO plugin_test.rows (value) VALUES (${expression})`, "plugin_test",
      )).not.toThrow();
      expect(() => validatePluginMigrationStatement(
        `CREATE TABLE plugin_test.rows (value text DEFAULT ${expression})`, "plugin_test",
      )).not.toThrow();
    }

    for (const type of [
      "public.audit_domain", '"public"."audit_domain"', "public.audit_domain.extra",
      "plugin_test.audit_domain", "audit_domain", '"audit_domain"', '"SELECT"', "pg_catalog.audit_domain",
      "public.audit_domain[]", "public.audit_domain(12)", "audit_domain(12)[]", "lower", "filter", "trim", "coalesce",
    ]) {
      const expression = `${type} 'unsafe'`;
      expect(() => validatePluginRuntimeQuery(`SELECT ${expression}`, "plugin_test"))
        .toThrow(/type.*not allowed/i);
      expect(() => validatePluginRuntimeExecute(
        `INSERT INTO plugin_test.rows (value) VALUES (${expression})`, "plugin_test",
      )).toThrow(/type.*not allowed/i);
      expect(() => validatePluginMigrationStatement(
        `CREATE TABLE plugin_test.rows (value text DEFAULT ${expression})`, "plugin_test",
      )).toThrow(/type.*not allowed/i);
    }

    expect(() => validatePluginRuntimeQuery(
      "SELECT public /* schema */ . audit_domain /* target */ 'unsafe'", "plugin_test",
    )).toThrow(/type.*not allowed/i);
    expect(() => validatePluginRuntimeQuery(
      "SELECT 'public.audit_domain ''unsafe''' AS sample /* public.audit_domain 'ignored' */", "plugin_test",
    )).not.toThrow();
    expect(() => validatePluginRuntimeQuery(
      "SELECT $tag$public.audit_domain 'unsafe'$tag$ AS sample", "plugin_test",
    )).not.toThrow();
    expect(() => validatePluginRuntimeQuery(
      String.raw`SELECT E'escaped\ntext', U&'d\0061ta', B'0101', X'CAFE', N'national'`, "plugin_test",
    )).not.toThrow();
    expect(() => validatePluginRuntimeQuery(
      "SELECT now() AT TIME ZONE 'UTC', CASE WHEN true THEN 'yes' ELSE 'no' END", "plugin_test",
    )).not.toThrow();
  });

  it("rejects function fallback through expression and scalar field notation", () => {
    for (const expression of [
      "('PG_VERSION'::text).pg_read_file", "(('PG_VERSION'::text)).lo_import",
      '(\'PG_VERSION\'::text) /* outer /* inner */ trailing */ . "pg_read_file"',
      "$1.pg_read_file", "(ARRAY['PG_VERSION'])[1].pg_read_file",
    ]) {
      expect(() => validatePluginRuntimeQuery(`SELECT ${expression}`, "plugin_test")).toThrow(/field notation/i);
      expect(() => validatePluginRuntimeExecute(`INSERT INTO plugin_test.rows (body) SELECT ${expression}`, "plugin_test"))
        .toThrow(/field notation/i);
      for (const definition of [
        `body text DEFAULT ${expression}`,
        `body text GENERATED ALWAYS AS (${expression}) STORED`,
        `body text CHECK (${expression} IS NOT NULL)`,
      ]) {
        expect(() => validatePluginMigrationStatement(`CREATE TABLE plugin_test.rows (${definition})`, "plugin_test"))
          .toThrow(/field notation/i);
      }
      expect(() => validatePluginMigrationStatement(`CREATE INDEX rows_idx ON plugin_test.rows ((${expression}))`, "plugin_test"))
        .toThrow(/field notation/i);
    }
    for (const statement of [
      "SELECT t.pg_read_file FROM unnest(ARRAY['PG_VERSION']) t",
      'SELECT t."lo_import" FROM unnest(ARRAY[\'PG_VERSION\']) AS t(path)',
      "SELECT unnest.pg_read_file FROM pg_catalog.unnest(ARRAY['PG_VERSION'])",
      "SELECT (SELECT t.pg_read_file) FROM unnest(ARRAY['PG_VERSION']) t(path)",
    ]) {
      expect(() => validatePluginRuntimeQuery(statement, "plugin_test")).toThrow(/field notation/i);
    }
    for (const statement of [
      "SELECT t.body FROM plugin_test.rows t",
      "SELECT t.path FROM unnest(ARRAY['PG_VERSION']) t(path)",
      "SELECT (SELECT t.body FROM plugin_test.rows t) FROM unnest(ARRAY['PG_VERSION']) t(path)",
      "SELECT 1.e2, 1.e+2, 1.5",
    ]) {
      expect(() => validatePluginRuntimeQuery(statement, "plugin_test")).not.toThrow();
    }
  });

  it("keeps identity sequence targets inside the namespace", () => {
    for (const statement of [
      "CREATE TABLE plugin_test.rows (id integer GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME public.escaped_identity))",
      'CREATE TABLE "plugin_test"."rows" (id integer GENERATED BY DEFAULT AS IDENTITY (sequence /* outer /* inner */ trailing */ name "public"."escaped_identity"))',
      "CREATE TABLE plugin_test.rows (id integer GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME escaped_identity))",
      "ALTER TABLE plugin_test.rows ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME public.escaped_identity)",
      'ALTER TABLE plugin_test.rows ALTER COLUMN id SET SEQUENCE/**/NAME "public"."escaped_identity"',
    ]) {
      expect(() => validatePluginMigrationStatement(statement, "plugin_test"))
        .toThrow(/fully qualified|outside namespace/i);
    }
    expect(() => validatePluginMigrationStatement(
      "CREATE TABLE plugin_test.rows (id integer GENERATED ALWAYS AS IDENTITY (OWNED BY public.rows.id))", "plugin_test",
    )).toThrow(/sequence ownership/i);
    for (const statement of [
      "CREATE TABLE plugin_test.rows (id integer GENERATED ALWAYS AS IDENTITY)",
      "CREATE TABLE plugin_test.rows (id integer GENERATED BY DEFAULT AS IDENTITY (SEQUENCE NAME plugin_test.rows_id_seq))",
      'CREATE TABLE "plugin_test"."rows" (id integer GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME "plugin_test"."sequence name public.bad"))',
      "ALTER TABLE plugin_test.rows ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME plugin_test.rows_id_seq)",
      "ALTER TABLE plugin_test.rows ALTER COLUMN id SET SEQUENCE NAME plugin_test.rows_id_seq",
      "ALTER TABLE plugin_test.rows ALTER COLUMN id SET GENERATED BY DEFAULT",
      "ALTER TABLE plugin_test.rows ALTER COLUMN label SET STORAGE EXTERNAL",
    ]) {
      expect(() => validatePluginMigrationStatement(statement, "plugin_test")).not.toThrow();
    }
  });

  it("rejects nested administrative DDL options and copied table definitions", () => {
    for (const statement of [
      "CREATE TABLE plugin_test.rows (id integer) TABLESPACE pg_default",
      'CREATE TABLE plugin_test.rows (id integer) TABLESPACE "pg_default"',
      "CREATE TABLE plugin_test.rows (id integer PRIMARY KEY USING INDEX TABLESPACE pg_default)",
      "CREATE INDEX rows_idx ON plugin_test.rows (id) TABLESPACE pg_default",
      "ALTER TABLE plugin_test.rows ADD CONSTRAINT rows_pk PRIMARY KEY (id) USING INDEX TABLESPACE pg_default",
    ]) {
      expect(() => validatePluginMigrationStatement(statement, "plugin_test")).toThrow(/tablespaces/i);
    }
    for (const statement of [
      "CREATE TABLE plugin_test.rows (id integer) USING heap",
      "CREATE TABLE plugin_test.rows USING heap AS SELECT 1 AS id",
      "CREATE INDEX rows_idx ON plugin_test.rows USING /* outer /* inner */ trailing */ btree (id)",
    ]) {
      expect(() => validatePluginMigrationStatement(statement, "plugin_test")).toThrow(/access methods/i);
    }
    expect(() => validatePluginMigrationStatement(
      "CREATE TABLE plugin_test.rows (LIKE public.issues INCLUDING ALL)", "plugin_test", ["issues"],
    )).toThrow(/clone table definitions/i);
    expect(() => validatePluginMigrationStatement("CREATE TABLE plugin_test.rows OF public.some_type", "plugin_test"))
      .toThrow(/only support/i);
    expect(() => validatePluginMigrationStatement("CREATE TABLE plugin_test.rows AS EXECUTE saved_query", "plugin_test"))
      .toThrow(/explicit query sources/i);
  });

  it("validates migration SELECT sources and rejects data-changing DDL bodies", () => {
    for (const statement of [
      "CREATE TABLE plugin_test.copied AS TABLE public.agents",
      "CREATE TABLE plugin_test.copied AS TABLE /* outer /* inner */ trailing */ agents",
      "CREATE TABLE plugin_test.copied AS SELECT b.* FROM plugin_test.rows a, public.agents b",
      'CREATE TABLE "plugin_test"."copied" AS SELECT b.* FROM "plugin_test"."rows" a, "agents" b',
      "CREATE TABLE plugin_test.rows (id uuid REFERENCES issues(id))",
    ]) {
      expect(() => validatePluginMigrationStatement(statement, "plugin_test"))
        .toThrow(/fully qualified|whitelisted/i);
    }
    for (const statement of [
      "CREATE TABLE plugin_test.copied AS WITH changed AS (DELETE FROM public.issues RETURNING id) SELECT id FROM changed",
      "CREATE TABLE plugin_test.copied AS WITH changed AS (UPDATE public.issues SET title = 'changed' RETURNING id) SELECT id FROM changed",
      "CREATE TABLE plugin_test.copied AS WITH changed AS (INSERT INTO plugin_test.rows (id) VALUES (1) RETURNING id) SELECT id FROM changed",
    ]) {
      expect(() => validatePluginMigrationStatement(statement, "plugin_test", ["issues"]))
        .toThrow(/data-changing/i);
    }
    for (const statement of [
      "CREATE TABLE IF NOT EXISTS plugin_test.rows (id uuid PRIMARY KEY)",
      "ALTER TABLE plugin_test.rows ALTER COLUMN id TYPE text USING (id::text)",
      "ALTER TABLE plugin_test.rows ADD COLUMN label text, ADD COLUMN count integer DEFAULT 0",
      "CREATE TABLE plugin_test.child (issue_id uuid REFERENCES public.issues(id) ON DELETE CASCADE ON UPDATE CASCADE)",
      "CREATE TABLE plugin_test.copied AS WITH rows AS (TABLE plugin_test.rows) SELECT * FROM rows",
      "CREATE TABLE plugin_test.copied AS TABLE public.issues",
    ]) {
      expect(() => validatePluginMigrationStatement(statement, "plugin_test", ["issues"])).not.toThrow();
    }
  });

  it("rejects Unicode escape identifiers without confusing quoted strings or names", () => {
    for (const statement of [
      'WITH u AS (SELECT 1) SELECT * FROM U&"public"."agents"',
      'WITH u AS (SELECT 1) SELECT * FROM u&"public"."agents"',
      String.raw`WITH u AS (SELECT 1) SELECT * FROM U&"p\0075blic"."agents"`,
      String.raw`SELECT * FROM U&"p!0075blic" UESCAPE '!' ."agents"`,
      'SELECT * FROM /* outer /* inner */ trailing */ U&"public"."agents"',
      String.raw`SELECT U&"pg_\0072ead_file"('PG_VERSION')`,
    ]) {
      expect(() => validatePluginRuntimeQuery(statement, "plugin_test"))
        .toThrow(/Unicode escape quoted identifiers/i);
    }
    expect(() => validatePluginRuntimeExecute(
      'WITH u AS (SELECT 1) INSERT INTO plugin_test.rows SELECT * FROM U&"public"."agents"', "plugin_test",
    )).toThrow(/Unicode escape quoted identifiers/i);
    expect(() => validatePluginMigrationStatement(
      'CREATE TABLE plugin_test.copied AS TABLE U&"public"."agents"', "plugin_test",
    )).toThrow(/Unicode escape quoted identifiers/i);
    for (const statement of [
      "WITH k AS (SELECT 1) SELECT * FROM \u212a",
      "SELECT * FROM \u00e9agents",
      "SELECT \u00e9function()",
      "SELECT 'left' OPERATOR(pg_catalog.||) 'right'",
    ]) {
      expect(() => validatePluginRuntimeQuery(statement, "plugin_test"))
        .toThrow(/fully qualified|function.*not allowed/i);
    }
    for (const statement of [
      String.raw`SELECT E'it\'s not SQL; TABLE public.agents', U&'d\0061ta', B'01', X'FF'`,
      "SELECT $\u00e9$TABLE public.agents; 'quote' /* comment */$\u00e9$",
      'SELECT "U&public" FROM "plugin_test"."rows"',
    ]) {
      expect(() => validatePluginRuntimeQuery(statement, "plugin_test")).not.toThrow();
    }
    expect(() => validatePluginRuntimeQuery(
      "SELECT $\u00e9$harmless$\u00e9$ FROM public.agents", "plugin_test",
    )).toThrow(/whitelisted/i);
  });

  it("keeps migration relocation and comments inside the namespace", () => {
    for (const statement of [
      "ALTER TABLE plugin_test.rows SET SCHEMA public",
      'ALTER TABLE "plugin_test"."rows" SET /* outer /* inner */ trailing */ SCHEMA "public"',
    ]) {
      expect(() => validatePluginMigrationStatement(statement, "plugin_test"))
        .toThrow(/cannot move objects between schemas/i);
    }
    for (const statement of [
      "COMMENT ON COLUMN public.issues.title IS 'changed'",
      'COMMENT/**/ON/**/COLUMN "public"."issues"."title" IS \'changed\'',
      "COMMENT ON COLUMN /* outer /* inner */ trailing */ public.issues.title IS 'changed'",
      "COMMENT ON TABLE public.issues IS 'changed'",
      "COMMENT ON SCHEMA public IS 'changed'",
      "COMMENT ON DATABASE postgres IS 'changed'",
      "COMMENT ON COLUMN rows.label IS 'unqualified'",
    ]) {
      expect(() => validatePluginMigrationStatement(statement, "plugin_test", ["issues"]))
        .toThrow(/comments.*namespace/i);
    }
    for (const statement of [
      "COMMENT ON TABLE plugin_test.rows IS 'own table'",
      'COMMENT ON COLUMN "plugin_test"."rows"."label" IS \'own column\'',
      "COMMENT ON INDEX plugin_test.rows_idx IS 'own index'",
      "COMMENT ON SEQUENCE plugin_test.rows_seq IS 'own sequence'",
      "COMMENT ON SCHEMA plugin_test IS 'own namespace'",
    ]) {
      expect(() => validatePluginMigrationStatement(statement, "plugin_test")).not.toThrow();
    }
  });

  it("rejects administrative DDL and validates real targets despite quoted decoys", () => {
    for (const statement of [
      'CREATE ROLE "from plugin_test.rows" SUPERUSER LOGIN',
      'CREATE USER "from plugin_test.rows" SUPERUSER',
      'CREATE DATABASE "from plugin_test.rows"',
      'CREATE TABLESPACE "from plugin_test.rows" LOCATION \'/missing/path\'',
      'ALTER ROLE "from plugin_test.rows" SUPERUSER',
      'ALTER INDEX public.core_idx RENAME TO "from plugin_test.rows"',
      'CREATE POLICY "from plugin_test.rows" ON public.issues USING (true)',
      'CREATE PUBLICATION "from plugin_test.rows" FOR ALL TABLES',
      'CREATE SUBSCRIPTION "from plugin_test.rows" CONNECTION \'ignored\' PUBLICATION ignored',
      'CREATE PROCEDURE plugin_test.proc() LANGUAGE sql AS $$ SELECT 1 $$',
      'CREATE SEQUENCE public.escaped "from plugin_test.rows"',
      'ALTER TABLE plugin_test.rows OWNER TO "from plugin_test.rows"',
      'ALTER TABLE plugin_test.rows SET TABLESPACE "from plugin_test.rows"',
      'ALTER TABLE plugin_test.rows ADD COLUMN safe integer, OWNER TO "from plugin_test.rows"',
    ]) {
      expect(() => validatePluginMigrationStatement(statement, "plugin_test", ["issues"]))
        .toThrow(/only support/i);
    }
    for (const statement of [
      'CREATE TABLE public."from plugin_test.rows" (id integer)',
      'CREATE INDEX "from plugin_test.rows" ON public.issues (id)',
      'ALTER TABLE public.issues RENAME TO "from plugin_test.rows"',
      'CREATE INDEX "from plugin_test.rows" ON issues (id)',
    ]) {
      expect(() => validatePluginMigrationStatement(statement, "plugin_test", ["issues"]))
        .toThrow(/outside namespace|fully qualified/i);
    }
    for (const statement of [
      'CREATE TABLE plugin_test."from public.issues" ("join public.agents" text)',
      'CREATE INDEX "from public.issues" ON plugin_test.rows (label)',
      'ALTER TABLE plugin_test.rows ADD COLUMN "from public.issues" text',
    ]) {
      expect(() => validatePluginMigrationStatement(statement, "plugin_test")).not.toThrow();
    }
    expect(() => validatePluginRuntimeQuery(
      'SELECT "from public.issues" FROM plugin_test.rows', "plugin_test",
    )).not.toThrow();
  });

  it("rejects views that could relay writes into core tables", () => {
    for (const statement of [
      "CREATE VIEW plugin_test.issue_proxy AS SELECT id, title FROM public.issues",
      "CREATE OR REPLACE VIEW plugin_test.issue_proxy AS SELECT id, title FROM public.issues",
      "CREATE OR REPLACE RECURSIVE VIEW plugin_test.issue_tree (id) AS SELECT id FROM public.issues",
      "CREATE MATERIALIZED VIEW plugin_test.issue_snapshot AS SELECT id, title FROM public.issues",
      "CREATE VIEW plugin_test.local_proxy AS SELECT id FROM plugin_test.rows",
    ]) {
      expect(() =>
        validatePluginMigrationStatement(statement, "plugin_test", ["issues"])
      ).toThrow(/cannot create views/i);
    }
  });

  it("rejects partition attachment changes in migrations", () => {
    for (const statement of [
      "ALTER TABLE plugin_test.proxy ATTACH PARTITION public.not_allowed DEFAULT",
      'ALTER TABLE "plugin_test"."proxy" ATTACH/**/PARTITION "public"."not_allowed" DEFAULT',
      "ALTER TABLE plugin_test.proxy DETACH PARTITION public.not_allowed",
      'ALTER TABLE "plugin_test"."proxy" DETACH/**/PARTITION "public"."not_allowed" CONCURRENTLY',
      "ALTER TABLE plugin_test.proxy ATTACH /* outer /* inner */ trailing */ PARTITION public.not_allowed DEFAULT",
    ]) {
      expect(() => validatePluginMigrationStatement(statement, "plugin_test"))
        .toThrow(/cannot attach or detach partitions/i);
    }
  });

  it("rejects inheritance changes and partition creation in migrations", () => {
    for (const statement of [
      "CREATE TABLE plugin_test.proxy () INHERITS (public.not_allowed)",
      "ALTER TABLE plugin_test.proxy INHERIT public.not_allowed",
      'ALTER TABLE "plugin_test"."proxy" NO /* outer /* inner */ trailing */ INHERIT "public"."not_allowed"',
      "CREATE TABLE plugin_test.proxy () INHERITS /* outer /* inner */ trailing */ (public.not_allowed)",
      "CREATE TABLE plugin_test.proxy PARTITION /* outer /* inner */ trailing */ OF public.not_allowed DEFAULT",
    ]) {
      expect(() => validatePluginMigrationStatement(statement, "plugin_test"))
        .toThrow(/inheritance|table partitions/i);
    }
  });

  it("uses consistent lexical handling for comments, quotes, and dollar strings", () => {
    for (const statement of [
      "CREATE /* outer /* inner */ trailing */ VIEW plugin_test.proxy AS SELECT * FROM plugin_test.rows",
      "CREATE /* outer /* inner */ trailing */ RULE relay AS ON INSERT TO plugin_test.rows DO ALSO DELETE FROM public.issues",
    ]) {
      expect(() => validatePluginMigrationStatement(statement, "plugin_test", ["issues"]))
        .toThrow(/cannot create views|disallowed/i);
    }
    expect(() => validatePluginRuntimeQuery(
      "WITH stolen AS (TABLE /* outer /* inner */ trailing */ public.agents) SELECT * FROM stolen", "plugin_test",
    )).toThrow(/whitelisted/i);
    expect(() => validatePluginRuntimeExecute(
      "WITH saved AS (INSERT INTO plugin_test.rows (id) VALUES (1) RETURNING id) SELECT id INTO /* outer /* inner */ trailing */ escaped FROM saved",
      "plugin_test",
    )).toThrow(/SELECT INTO/i);
    expect(() => validatePluginRuntimeExecute(
      "UPDATE /* outer /* inner */ trailing */ public.issues SET title = 'changed'", "plugin_test",
    )).toThrow(/namespace/i);
    for (const statement of [
      "SELECT 'TABLE public.agents; -- comment' FROM plugin_test.rows",
      "SELECT $$FROM public.agents; /* comment */ 'quote'$$ FROM plugin_test.rows",
      "SELECT $tag$INTO public.agents; -- comment 'quote'$tag$ FROM plugin_test.rows",
      String.raw`SELECT E'it\'s TABLE public.agents; /* comment */' FROM plugin_test.rows`,
      'SELECT "/* quoted identifier */" FROM "plugin_test"."rows" -- trailing comment',
      "SELECT id FROM /* outer /* inner */ trailing */ plugin_test.rows; -- trailing comment",
    ]) {
      expect(() => validatePluginRuntimeQuery(statement, "plugin_test")).not.toThrow();
    }
  });

  it("rejects rules that could relay writes into core tables", () => {
    for (const action of [
      "DELETE FROM public.issues WHERE id = OLD.id",
      "UPDATE public.issues SET title = 'changed' WHERE id = NEW.id",
      "INSERT INTO public.issues (id, company_id, title) VALUES (NEW.id, NEW.company_id, NEW.title)",
    ]) {
      expect(() =>
        validatePluginMigrationStatement(
          `CREATE RULE relay_core_write AS ON INSERT TO plugin_test.rows DO ALSO ${action}`,
          "plugin_test",
          ["issues"],
        )
      ).toThrow(/disallowed/i);
    }

    for (const action of [
      "DELETE/**/FROM/**/public.issues WHERE id = OLD.id",
      "UPDATE/**/public.issues SET title = 'changed' WHERE id = NEW.id",
      "INSERT/**/INTO/**/public.issues (id, company_id, title) VALUES (NEW.id, NEW.company_id, NEW.title)",
    ]) {
      expect(() =>
        validatePluginMigrationStatement(
          `CREATE/**/OR/**/REPLACE/**/RULE relay_core_write AS ON INSERT TO plugin_test.rows DO ALSO ${action}`,
          "plugin_test",
          ["issues"],
        )
      ).toThrow(/disallowed/i);
    }

    expect(() =>
      validatePluginMigrationStatement(
        "ALTER TABLE plugin_test.rows ENABLE/**/ALWAYS/**/RULE relay_core_write",
        "plugin_test",
      )
    ).toThrow(/disallowed/i);
  });

  it("allows whitelisted runtime reads but rejects public writes", () => {
    expect(() =>
      validatePluginRuntimeQuery(
        "SELECT r.id FROM plugin_test.rows r JOIN public.issues i ON i.id = r.issue_id",
        "plugin_test",
        ["issues"],
      )
    ).not.toThrow();
    expect(() =>
      validatePluginRuntimeExecute("UPDATE public.issues SET title = $1", "plugin_test")
    ).toThrow(/namespace/i);
    expect(() =>
      validatePluginRuntimeQuery("SELECT * FROM ONLY public.agents", "plugin_test", [])
    ).toThrow(/agents|whitelist/i);
    expect(() =>
      validatePluginRuntimeQuery("SELECT * FROM ONLY public.issues", "plugin_test", ["issues"])
    ).not.toThrow();
    expect(() =>
      validatePluginRuntimeQuery(
        "SELECT agent_id, idempotency_key, status FROM public.agent_wakeup_requests",
        "plugin_test",
        ["agent_wakeup_requests"],
      )
    ).not.toThrow();
    expect(() =>
      validatePluginRuntimeQuery(
        "SELECT agent_id, idempotency_key, status FROM public.agent_wakeup_requests",
        "plugin_test",
        [],
      )
    ).toThrow(/agent_wakeup_requests|whitelist/i);
    for (const query of [
      "SELECT * FROM agents",
      'SELECT * FROM "agents"',
      "SELECT * FROM/**/agents",
      "SELECT * FROM plugin_test.rows, agents",
    ]) {
      expect(() => validatePluginRuntimeQuery(query, "plugin_test", ["agents"]))
        .toThrow(/fully qualified/i);
    }
    expect(() => validatePluginRuntimeQuery(
      "WITH local_rows AS (SELECT id FROM plugin_test.rows) SELECT id FROM local_rows",
      "plugin_test",
    )).not.toThrow();
    for (const query of [
      "SELECT id INTO plugin_test.copied_rows FROM plugin_test.rows",
      "SELECT id/**/INTO/**/plugin_test.copied_rows FROM plugin_test.rows",
      'SELECT id INTO "plugin_test"."copied_rows" FROM "plugin_test"."rows"',
    ]) {
      expect(() => validatePluginRuntimeQuery(query, "plugin_test"))
        .toThrow(/select into/i);
    }
  });

  it("allows existing plugin JSON batch and source-protection queries", () => {
    // email-tools agent-moves.ts and review-queue.ts use set functions in
    // INSERT ... SELECT, including nested functions in the conflict update.
    for (const statement of [
      `INSERT INTO plugin_test.email_agent_triage_moves (mailbox_key, message_key, company_id, moved_at)
       SELECT $1, t.k, $2::uuid, $3::timestamptz FROM jsonb_array_elements_text($4::jsonb) AS t(k)
       ON CONFLICT (mailbox_key, message_key) DO UPDATE SET moved_at = EXCLUDED.moved_at`,
      `INSERT INTO plugin_test.email_review_queue AS q
         (company_id, mailbox_key, sender, message_ids, message_count, first_seen_at, last_seen_at)
       SELECT $1::uuid, $2, e.sender, ARRAY(SELECT jsonb_array_elements_text(e.message_keys)),
              greatest(jsonb_array_length(e.message_keys), e.at_least), e.first_seen_at, e.last_seen_at
       FROM jsonb_to_recordset($3::jsonb) AS e(
         sender text, message_keys jsonb, at_least integer, first_seen_at timestamptz, last_seen_at timestamptz)
       ON CONFLICT (company_id, mailbox_key, sender) DO UPDATE SET
         message_count = greatest(q.message_count + (
           SELECT count(*)::int FROM unnest(EXCLUDED.message_ids) AS m(id) WHERE m.id <> ALL (q.message_ids)
         ), EXCLUDED.message_count),
         message_ids = (
           SELECT s.ids[greatest(cardinality(s.ids) - 499, 1):]
           FROM (SELECT q.message_ids || ARRAY(
             SELECT m.id FROM unnest(EXCLUDED.message_ids) AS m(id) WHERE m.id <> ALL (q.message_ids)
           ) AS ids) AS s
         ), updated_at = now()`,
    ]) {
      expect(() => validatePluginRuntimeExecute(statement, "plugin_test")).not.toThrow();
    }

    // customer-support source-protection.ts filters its migration scope using
    // a correlated JSON array expansion rather than a persistent table.
    expect(() => validatePluginRuntimeQuery(
      `SELECT m.*, c.title, c.external_url, c.source_account_id FROM plugin_test.support_messages m
       JOIN plugin_test.support_cases c ON c.company_id = m.company_id AND c.id = m.case_id
       WHERE m.source_protection_version = 0 AND c.source_account_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM jsonb_array_elements($1::jsonb) s WHERE s->>'companyId' = m.company_id::text
           AND s->>'connectionId' = c.connection_id AND s->>'accountId' = c.source_account_id AND s->>'routeId' = c.external_route_id)
       ORDER BY m.occurred_at LIMIT 20`,
      "plugin_test",
    )).not.toThrow();
    expect(() => validatePluginRuntimeQuery(
      "SELECT r.id, t.k FROM plugin_test.rows r CROSS JOIN LATERAL jsonb_array_elements_text(r.keys) AS t(k)",
      "plugin_test",
    )).not.toThrow();
  });

  it("allows business-records null-safe date and UUID comparisons without hiding relation reads", () => {
    expect(() => validatePluginRuntimeQuery(
      `SELECT d.id FROM plugin_test.business_documents d WHERE d.company_id = $1 AND d.business_id = $2
       AND (d.issue_id = $3 AND d.doc_type = $4 AND d.attachment_ref IS NULL
         AND lower(d.title) = lower($5) AND d.document_date IS NOT DISTINCT FROM $6::date)
       ORDER BY d.created_at LIMIT 1`,
      "plugin_test",
    )).not.toThrow();
    for (const statement of [
      `UPDATE plugin_test.business_filings SET due_date = $1::date, updated_at = now()
       WHERE company_id = $2 AND id = $3 AND due_date = $4::date AND due_date_kind = $5
         AND due_date_source_document_id IS NOT DISTINCT FROM $6::uuid`,
      `UPDATE plugin_test.business_filings SET status = $1, updated_at = now()
       WHERE company_id = $2 AND id = $3 AND status = $4 AND due_date = $5::date
         AND extended_due_date IS NOT DISTINCT FROM $6::date AND extended_due_date_kind = $7
         AND extended_due_date_source_document_id IS NOT DISTINCT FROM $8::uuid`,
    ]) {
      expect(() => validatePluginRuntimeExecute(statement, "plugin_test")).not.toThrow();
    }
    for (const comparison of ["IS DISTINCT FROM", "IS NOT DISTINCT FROM"]) {
      expect(() => validatePluginRuntimeQuery(
        `SELECT id FROM plugin_test.rows WHERE id ${comparison} $1::uuid`,
        "plugin_test",
      )).not.toThrow();
      expect(() => validatePluginRuntimeQuery(
        `SELECT id FROM plugin_test.rows WHERE id ${comparison} (SELECT id FROM agents)`,
        "plugin_test",
      )).toThrow(/fully qualified/i);
    }
  });

  it("still validates persistent relations beside and inside table functions", () => {
    for (const statement of [
      "SELECT * FROM jsonb_array_elements_text",
      'SELECT * FROM "jsonb_array_elements"',
      "SELECT * FROM unnest",
      "SELECT * FROM arbitrary_function($1)",
      "SELECT * FROM jsonb_array_elements_text($1::jsonb), agents",
      "SELECT * FROM jsonb_array_elements_text($1::jsonb), plugin_test.rows, agents",
      "SELECT * FROM plugin_test.rows, plugin_test.other_rows, agents",
      "SELECT * FROM plugin_test.rows, plugin_test.other_rows, public.agents",
      "SELECT * FROM plugin_test.rows r JOIN plugin_test.other_rows o USING (id), agents",
      "SELECT * FROM plugin_test.rows r JOIN plugin_test.other_rows o ON r.id = o.id, agents",
      "SELECT * FROM plugin_test.rows r JOIN plugin_test.other_rows o ON r.id IS NOT DISTINCT FROM o.id, agents",
      'SELECT * FROM plugin_test "." WHERE true',
      'SELECT * FROM plugin_test.rows "(", agents',
      'SELECT * FROM plugin_test.rows ")", agents',
      "SELECT * FROM jsonb_array_elements((SELECT data FROM agents))",
      "SELECT * FROM plugin_test.rows CROSS JOIN LATERAL agents",
      "SELECT * FROM ONLY (agents)",
      "SELECT * FROM (agents JOIN plugin_test.rows ON true)",
    ]) {
      expect(() => validatePluginRuntimeQuery(statement, "plugin_test"))
        .toThrow(/fully qualified|whitelisted|function.*not allowed/i);
    }
    for (const statement of [
      "DELETE FROM plugin_test.rows USING plugin_test.a, plugin_test.b, agents WHERE true",
      "DELETE FROM plugin_test.rows USING plugin_test.a, plugin_test.b, public.agents WHERE true",
      "DELETE FROM plugin_test.rows USING jsonb_array_elements_text($1::jsonb), agents WHERE true",
      "DELETE FROM plugin_test.rows USING plugin_test.a JOIN plugin_test.b USING (id), agents WHERE true",
      "DELETE FROM plugin_test.rows USING plugin_test.a JOIN plugin_test.b ON a.id = b.id, agents WHERE true",
      "DELETE FROM plugin_test.rows USING (agents JOIN plugin_test.b USING (id)) WHERE true",
      "DELETE FROM plugin_test.rows USING (agents JOIN plugin_test.b ON agents.id = b.id) WHERE true",
    ]) {
      expect(() => validatePluginRuntimeExecute(statement, "plugin_test"))
        .toThrow(/fully qualified|schema/i);
    }
    expect(() => validatePluginRuntimeQuery(
      "SELECT * FROM plugin_test.rows, plugin_test.other_rows, jsonb_array_elements_text($1::jsonb) AS t(k)",
      "plugin_test",
    )).not.toThrow();
  });

  it("validates TABLE shorthand wherever it supplies a relation", () => {
    for (const statement of [
      "WITH stolen AS (TABLE public.agents) SELECT * FROM stolen",
      'WITH stolen AS (TABLE/**/"public"."agents") SELECT * FROM stolen',
      "SELECT * FROM (TABLE public.agents) AS stolen",
      "SELECT EXISTS (TABLE ONLY public.agents)",
      "SELECT (TABLE agents)",
      "WITH agents AS (TABLE agents) SELECT * FROM agents",
      "WITH first AS (TABLE agents), agents AS (TABLE plugin_test.rows) SELECT * FROM first",
      "WITH first AS (WITH agents AS (TABLE plugin_test.rows) TABLE agents) TABLE agents",
    ]) {
      expect(() => validatePluginRuntimeQuery(statement, "plugin_test"))
        .toThrow(/fully qualified|whitelisted/i);
    }
    for (const statement of [
      "WITH stolen AS (TABLE public.agents) INSERT INTO plugin_test.copied SELECT * FROM stolen",
      "INSERT INTO plugin_test.copied TABLE public.agents",
      'INSERT INTO plugin_test.copied (TABLE/**/ONLY/**/"public"."agents")',
      "UPDATE plugin_test.rows SET id = (TABLE public.agents)",
      "DELETE FROM plugin_test.rows WHERE EXISTS (TABLE agents)",
    ]) {
      expect(() => validatePluginRuntimeExecute(statement, "plugin_test"))
        .toThrow(/fully qualified|schema/i);
    }
    for (const statement of [
      "WITH rows AS (TABLE plugin_test.rows), later AS (TABLE rows) SELECT * FROM later",
      "SELECT * FROM (TABLE plugin_test.rows) AS rows",
      "SELECT EXISTS (TABLE ONLY plugin_test.rows)",
      "WITH RECURSIVE rows AS (TABLE plugin_test.rows UNION ALL TABLE rows) SELECT * FROM rows",
    ]) {
      expect(() => validatePluginRuntimeQuery(statement, "plugin_test")).not.toThrow();
    }
    expect(() => validatePluginRuntimeQuery(
      'SELECT * FROM (TABLE/**/ONLY/**/"public"."issues") AS rows',
      "plugin_test", ["issues"],
    )).not.toThrow();
    expect(() => validatePluginRuntimeExecute(
      "WITH rows AS (TABLE plugin_test.rows) INSERT INTO plugin_test.copied TABLE rows",
      "plugin_test",
    )).not.toThrow();
  });

  it("limits CTE names to their SQL visibility scope", () => {
    for (const statement of [
      "WITH agents AS (SELECT * FROM agents) SELECT * FROM agents",
      "WITH first AS (SELECT * FROM agents), agents AS (SELECT * FROM plugin_test.rows) SELECT * FROM first",
      "WITH first AS (WITH agents AS (SELECT * FROM plugin_test.rows) SELECT * FROM agents) SELECT * FROM agents",
      "SELECT * FROM (WITH agents AS (SELECT * FROM plugin_test.rows) SELECT * FROM agents) AS nested, agents",
      "WITH rows AS (SELECT * FROM plugin_test.rows) SELECT * FROM (WITH agents AS (SELECT * FROM agents) SELECT * FROM agents) AS nested",
    ]) {
      expect(() => validatePluginRuntimeQuery(statement, "plugin_test"))
        .toThrow(/fully qualified/i);
    }
    for (const statement of [
      "WITH rows AS (SELECT * FROM plugin_test.rows), later AS (SELECT * FROM rows) SELECT * FROM later",
      "WITH rows (id) AS NOT MATERIALIZED (SELECT id FROM plugin_test.rows) SELECT * FROM rows",
      "SELECT * FROM (WITH rows AS (SELECT * FROM plugin_test.rows) SELECT * FROM rows) AS nested",
      "WITH rows AS (SELECT * FROM plugin_test.rows) SELECT * FROM (WITH rows AS (SELECT * FROM rows) SELECT * FROM rows) AS nested",
      "WITH RECURSIVE rows (id) AS (SELECT id FROM plugin_test.rows UNION ALL SELECT id FROM rows) SELECT * FROM rows",
      "WITH RECURSIVE first AS (SELECT * FROM later), later AS (SELECT * FROM plugin_test.rows) SELECT * FROM first",
    ]) {
      expect(() => validatePluginRuntimeQuery(statement, "plugin_test")).not.toThrow();
    }
  });

  it("recognizes conflict-update clauses independently of whitespace and comments", () => {
    for (const separator of [" ", "  ", "\n    ", "/**/", " /* outer /* inner */ trailing */ ", "-- comment\n "]) {
      expect(() => validatePluginRuntimeExecute(
        `INSERT INTO plugin_test.rows (id, label) VALUES ($1, $2) ON CONFLICT (id) DO${separator}UPDATE SET label = EXCLUDED.label`,
        "plugin_test",
      )).not.toThrow();
      expect(() => validatePluginRuntimeExecute(
        `WITH changed AS (UPDATE ONLY plugin_test.rows AS r SET label = $1 RETURNING id)
         INSERT INTO plugin_test.outbox SELECT id FROM changed ON CONFLICT (id) DO${separator}UPDATE SET id = EXCLUDED.id`,
        "plugin_test",
      )).not.toThrow();
      expect(() => validatePluginRuntimeExecute(
        `WITH changed AS (UPDATE public.issues SET title = $1 RETURNING id)
         INSERT INTO plugin_test.outbox SELECT id FROM changed ON CONFLICT (id) DO${separator}UPDATE SET id = EXCLUDED.id`,
        "plugin_test",
      )).toThrow(/namespace/i);
    }
  });

  it("allows one atomic namespace write through a data-changing WITH statement", () => {
    expect(() => validatePluginRuntimeExecute(
      "WITH saved AS (UPDATE plugin_test.rows SET label = $1 WHERE id = $2 RETURNING id) INSERT INTO plugin_test.outbox (id) SELECT id FROM saved",
      "plugin_test",
    )).not.toThrow();
    expect(() => validatePluginRuntimeExecute(
      "WITH saved AS (UPDATE plugin_test.rows SET label = $1 RETURNING id) INSERT INTO public.outbox (id) SELECT id FROM saved",
      "plugin_test",
    )).toThrow(/namespace|public/i);
    expect(() => validatePluginRuntimeExecute(
      "WITH rows AS (SELECT id FROM plugin_test.rows) SELECT id FROM rows",
      "plugin_test",
    )).toThrow(/must perform/i);
    expect(() => validatePluginRuntimeExecute(
      "WITH evidence AS (SELECT * FROM plugin_test.rows) DELETE FROM activity_log",
      "plugin_test",
    )).toThrow(/namespace/i);
    expect(() => validatePluginRuntimeExecute(
      "WITH changed AS (UPDATE ONLY public.activity_log SET action = 'changed' RETURNING id) INSERT INTO plugin_test.outbox (id) SELECT id FROM changed",
      "plugin_test",
    )).toThrow(/namespace|public/i);
    expect(() => validatePluginRuntimeExecute(
      "WITH changed AS (DELETE FROM ONLY activity_log RETURNING id) INSERT INTO plugin_test.outbox (id) SELECT id FROM changed",
      "plugin_test",
    )).toThrow(/namespace/i);
    expect(() => validatePluginRuntimeExecute(
      "WITH source AS (SELECT id FROM plugin_test.rows) MERGE INTO activity_log AS target USING source ON target.id = source.id WHEN MATCHED THEN DELETE",
      "plugin_test",
    )).toThrow(/merge/i);
    for (const query of [
      "DELETE FROM plugin_test.rows USING public.issues WHERE issues.id = rows.issue_id",
      "DELETE FROM plugin_test.rows USING/**/public.issues WHERE issues.id = rows.issue_id",
      'DELETE FROM "plugin_test"."rows" USING "public"."issues" WHERE issues.id = rows.issue_id',
      "DELETE FROM plugin_test.rows USING issues WHERE issues.id = rows.issue_id",
      "DELETE FROM plugin_test.rows USING plugin_test.other_rows, public.issues WHERE issues.id = rows.issue_id",
    ]) {
      expect(() => validatePluginRuntimeExecute(query, "plugin_test"))
        .toThrow(/schema|fully qualified/i);
    }
    expect(() => validatePluginRuntimeExecute(
      "WITH candidates AS (SELECT id FROM plugin_test.other_rows) DELETE FROM plugin_test.rows USING candidates WHERE candidates.id = rows.id",
      "plugin_test",
    )).not.toThrow();
    for (const query of [
      "WITH changed AS (UPDATE/**/public.issues SET title = 'changed' RETURNING id) INSERT INTO plugin_test.outbox (id) SELECT id FROM changed",
      "WITH changed AS (DELETE/**/FROM/**/public.issues RETURNING id) INSERT INTO plugin_test.outbox (id) SELECT id FROM changed",
      "WITH changed AS (INSERT/**/INTO/**/public.issues (id, company_id, title) VALUES ($1, $2, $3) RETURNING id) INSERT INTO plugin_test.outbox (id) SELECT id FROM changed",
    ]) {
      expect(() => validatePluginRuntimeExecute(query, "plugin_test")).toThrow(/namespace|public/i);
    }
    expect(() => validatePluginRuntimeQuery(
      "SELECT * FROM/**/ONLY/**/public.agents",
      "plugin_test",
      [],
    )).toThrow(/agents|whitelist/i);
  });

  it("rejects SELECT INTO and non-DML final commands after a mutation CTE", () => {
    const saved = "WITH saved AS (INSERT INTO plugin_test.rows (id) VALUES (1) RETURNING id)";
    for (const statement of [
      `${saved} SELECT id INTO escaped_from_plugin FROM saved`,
      `${saved} SELECT id/**/INTO/**/escaped_from_plugin FROM saved`,
      `${saved} SELECT id INTO public.escaped_from_plugin FROM saved`,
      `${saved} SELECT id INTO "public"."escaped_from_plugin" FROM saved`,
      `${saved} SELECT id INTO TEMP TABLE "escaped_from_plugin" FROM saved`,
      `${saved} SELECT id INTO UNLOGGED TABLE "public"."escaped_from_plugin" FROM saved`,
      `${saved} SELECT "insert" INTO escaped_from_plugin FROM (SELECT id AS "insert" FROM saved) s`,
      "WITH copied AS (SELECT id INTO escaped_from_plugin FROM plugin_test.rows) INSERT INTO plugin_test.rows SELECT id FROM copied",
    ]) {
      expect(() => validatePluginRuntimeExecute(statement, "plugin_test")).toThrow(/SELECT INTO/i);
    }
    for (const terminal of ["SELECT id FROM saved", "TABLE saved", "VALUES (1)", "VACUUM plugin_test.rows"]) {
      expect(() => validatePluginRuntimeExecute(`${saved} ${terminal}`, "plugin_test"))
        .toThrow(/must finish/i);
    }
    expect(() => validatePluginRuntimeExecute(
      'WITH "insert" (id) AS (INSERT INTO plugin_test.rows (id) VALUES (1) RETURNING id) TABLE "insert"',
      "plugin_test",
    )).toThrow(/must finish/i);
    expect(() => validatePluginRuntimeExecute(
      "WITH rows AS (SELECT 'into' AS label FROM plugin_test.rows) INSERT/**/INTO/**/plugin_test.outbox (label) SELECT label FROM rows",
      "plugin_test",
    )).not.toThrow();
  });

  it("rejects functions that execute SQL, read resources, or change session state", () => {
    for (const call of [
      "query_to_xml('SELECT * FROM public.agents', true, true, '')",
      "query_to_xmlschema('SELECT * FROM public.agents', true, true, '')",
      "table_to_xml('public.agents'::regclass, true, true, '')",
      "table_to_xmlschema('public.agents'::regclass, true, true, '')",
      "table_to_xml_and_xmlschema('public.agents'::regclass, true, true, '')",
      "schema_to_xml('public', true, true, '')",
      "database_to_xml(true, true, '')",
      "to_regclass('public.agents')",
      "pg_read_file('PG_VERSION')", "pg_read_binary_file('PG_VERSION')", "pg_ls_dir('.')", "pg_stat_file('PG_VERSION')",
      "lo_export(0, '/missing-directory/export')", "lo_import('/missing-directory/import')",
      "set_config('search_path', 'public', false)",
      "public.lower('unsafe overload')", '"public"."lower"(\'unsafe overload\')',
      "pg_catalog.pg_read_file /* outer /* inner */ trailing */ ('PG_VERSION')",
    ]) {
      expect(() => validatePluginRuntimeQuery(`SELECT ${call} AS value`, "plugin_test"))
        .toThrow(/function.*not allowed/i);
      expect(() => validatePluginRuntimeExecute(`INSERT INTO plugin_test.rows (label) SELECT ${call}`, "plugin_test"))
        .toThrow(/function.*not allowed/i);
    }
    expect(() => validatePluginMigrationStatement(
      "ALTER TABLE plugin_test.rows ALTER COLUMN label SET DEFAULT pg_read_file('PG_VERSION')", "plugin_test",
    )).toThrow(/function.*not allowed/i);
    expect(() => validatePluginRuntimeQuery(
      "SELECT pg_catalog.lower($1), array_to_string($2, ','), avg(1), cardinality($2), count(*), jsonb_agg($3), jsonb_array_length($3), jsonb_build_object('a', $1), max(1), now(), split_part($1, ',', 1), to_jsonb($1), coalesce($1, ''), greatest(1, 2), least(1, 2) FROM plugin_test.rows",
      "plugin_test",
    )).not.toThrow();
    expect(() => validatePluginRuntimeQuery(
      'SELECT t.k FROM "pg_catalog"."jsonb_array_elements_text"($1::jsonb) AS t(k)', "plugin_test",
    )).not.toThrow();
    expect(() => validatePluginMigrationStatement(
      "CREATE TABLE plugin_test.rows (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, label char(4), CHECK (length(btrim(label)) > 0))", "plugin_test",
    )).not.toThrow();
  });

  it("allows plugins to verify declared company skills without granting public writes", () => {
    expect(() =>
      validatePluginRuntimeQuery(
        "SELECT id, company_id, key, markdown FROM public.company_skills WHERE id = $1 AND company_id = $2",
        "plugin_test",
        ["company_skills"],
      )
    ).not.toThrow();
    expect(() =>
      validatePluginRuntimeQuery(
        "SELECT id FROM public.company_skills WHERE id = $1",
        "plugin_test",
      )
    ).toThrow(/not declared|company_skills/i);
  });

  it("targets anonymous DO blocks without rejecting do-prefixed aliases", () => {
    expect(() =>
      validatePluginRuntimeQuery(
        "SELECT EXTRACT(DOW FROM created_at) AS do_flag FROM plugin_test.rows",
        "plugin_test",
      )
    ).not.toThrow();
    expect(() =>
      validatePluginMigrationStatement("DO $$ BEGIN END $$;", "plugin_test")
    ).toThrow(/disallowed/i);
  });
});

describe("plugin migration checksums", () => {
  const lf = "CREATE TABLE ns.t (id uuid);\nCREATE INDEX t_idx ON ns.t (id);\n";
  const crlf = lf.replace(/\n/g, "\r\n");
  const rawHash = (text: string) => createHash("sha256").update(text).digest("hex");

  it("gives the same fingerprint to a file whatever its line endings", () => {
    expect(migrationChecksum(crlf)).toBe(migrationChecksum(lf));
  });

  it("still accepts fingerprints older builds recorded from raw bytes, with either line ending", () => {
    for (const onDisk of [lf, crlf]) {
      const accepted = acceptedMigrationChecksums(onDisk);
      expect(accepted).toContain(rawHash(lf));
      expect(accepted).toContain(rawHash(crlf));
      expect(accepted).toContain(migrationChecksum(onDisk));
    }
  });

  it("does not accept a real change to the SQL", () => {
    const edited = lf.replace("(id uuid)", "(id uuid, note text)");
    const accepted = acceptedMigrationChecksums(edited);
    for (const old of [migrationChecksum(lf), rawHash(lf), rawHash(crlf)]) {
      expect(accepted).not.toContain(old);
    }
  });
});

describeEmbeddedPostgres("plugin database namespaces", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let packageRoots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-db-");
    db = createDb(tempDb.connectionString);
  }, 90_000);

  afterEach(async () => {
    for (const pluginKey of ["paperclip.dbtest", "paperclip.escape"]) {
      const namespace = derivePluginDatabaseNamespace(pluginKey);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`));
    }
    await db.delete(pluginMigrations);
    await db.delete(pluginDatabaseNamespaces);
    await db.delete(plugins);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(companies);
    await Promise.all(packageRoots.map((root) => rm(root, { recursive: true, force: true })));
    packageRoots = [];
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createPluginPackage(manifest: PaperclipPluginManifestV1, migrationSql: string) {
    const packageRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-package-"));
    packageRoots.push(packageRoot);
    const migrationsDir = path.join(packageRoot, manifest.database!.migrationsDir);
    await mkdir(migrationsDir, { recursive: true });
    await writeFile(path.join(migrationsDir, "001_init.sql"), migrationSql, "utf8");
    return packageRoot;
  }

  async function installPluginRecord(manifest: PaperclipPluginManifestV1) {
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: manifest.id,
      packageName: manifest.id,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      categories: manifest.categories,
      manifestJson: manifest,
      status: "installed",
      installOrder: 1,
    });
    return pluginId;
  }

  function manifest(pluginKey = "paperclip.dbtest"): PaperclipPluginManifestV1 {
    return {
      id: pluginKey,
      apiVersion: 1,
      version: "1.0.0",
      displayName: "DB Test",
      description: "Exercises restricted plugin database access.",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: [
        "database.namespace.migrate",
        "database.namespace.read",
        "database.namespace.write",
      ],
      entrypoints: { worker: "./dist/worker.js" },
      database: {
        migrationsDir: "migrations",
        coreReadTables: ["issues"],
      },
    };
  }

  it("applies migrations once and allows whitelisted core joins at runtime", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(
      pluginManifest,
      `
      CREATE TABLE ${namespace}.mission_rows (
        id uuid PRIMARY KEY,
        issue_id uuid NOT NULL REFERENCES public.issues(id),
        label text NOT NULL
      );
      `,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "TST",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Joined issue",
      status: "todo",
      priority: "medium",
      identifier: "TST-1",
    });

    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);

    await pluginDb.execute(
      pluginId,
      `INSERT INTO ${namespace}.mission_rows (id, issue_id, label) VALUES ($1, $2, $3)`,
      [randomUUID(), issueId, "alpha"],
    );
    const rows = await pluginDb.query<{ label: string; title: string }>(
      pluginId,
      `SELECT m.label, i.title FROM ${namespace}.mission_rows m JOIN public.issues i ON i.id = m.issue_id`,
    );
    expect(rows).toEqual([{ label: "alpha", title: "Joined issue" }]);

    const migrations = await db
      .select()
      .from(pluginMigrations)
      .where(and(eq(pluginMigrations.pluginId, pluginId), eq(pluginMigrations.status, "applied")));
    expect(migrations).toHaveLength(1);
  });

  it("binds only placeholders in executable SQL", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(
      pluginManifest,
      `CREATE TABLE ${namespace}.rows (id integer);`,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);

    const rows = await pluginDb.query<{
      value: string; literal: string; "$3": number; dollar: string;
    }>(
      pluginId,
      `SELECT $1::text AS value, E'literal $2' AS literal, 1 AS "$3",
        $tag$dollar $4$tag$ AS dollar /* block $5 */ -- line $6`,
      ["bound"],
    );
    expect(rows).toEqual([{
      value: "bound", literal: "literal $2", "$3": 1, dollar: "dollar $4",
    }]);

    await expect(pluginDb.query(
      pluginId,
      `SELECT '$1' AS literal, 1 AS "$2", $tag$dollar $3$tag$ AS dollar /* $4 */ -- $5`,
      ["unused"],
    )).rejects.toThrow(/Every ctx\.db parameter must be referenced/i);
    await expect(pluginDb.query(pluginId, "SELECT $1::text"))
      .rejects.toThrow(/placeholder \$1 has no matching parameter/i);
    await expect(pluginDb.query(pluginId, "SELECT '$1' AS decoy, $2::text AS value", ["only-one"]))
      .rejects.toThrow(/placeholder \$2 has no matching parameter/i);
  });

  it("does not bind placeholder-shaped text inside unquoted identifiers", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(
      pluginManifest,
      `CREATE TABLE ${namespace}.rows (id integer);`,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);

    await expect(pluginDb.query<{ "value$1": number; bound: number }>(
      pluginId,
      "SELECT 41 AS value$1, $1::integer AS bound",
      [42],
    )).resolves.toEqual([{ "value$1": 41, bound: 42 }]);
    await expect(pluginDb.query<{ "value$1": number }>(pluginId, "SELECT 41 AS value$1"))
      .resolves.toEqual([{ "value$1": 41 }]);
    await expect(pluginDb.query(pluginId, "SELECT 41 AS value$1, $2::integer AS bound", [42]))
      .rejects.toThrow(/placeholder \$2 has no matching parameter/i);
    await expect(pluginDb.query(pluginId, "SELECT 41 AS value$1", [42]))
      .rejects.toThrow(/Every ctx\.db parameter must be referenced/i);
  });

  it("executes value table functions and null-safe comparisons against Postgres", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(
      pluginManifest,
      `CREATE TABLE ${namespace}.batch_rows (id text PRIMARY KEY, company_id uuid, due_date date, source_id uuid);`,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);
    const companyId = randomUUID();
    const sourceId = randomUUID();
    await pluginDb.execute(
      pluginId,
      `INSERT INTO ${namespace}.batch_rows (id, company_id)
       SELECT t.k, $1::uuid FROM jsonb_array_elements_text($2::jsonb) AS t(k)`,
      [companyId, JSON.stringify(["first"])],
    );
    await pluginDb.execute(
      pluginId,
      `INSERT INTO ${namespace}.batch_rows (id, company_id, due_date, source_id)
       SELECT e.id, $1::uuid, e.due_date::date, $2::uuid
       FROM jsonb_to_recordset($3::jsonb) AS e(id text, due_date text)`,
      [companyId, sourceId, JSON.stringify([{ id: "second", due_date: "2026-10-15" }])],
    );
    await pluginDb.execute(
      pluginId,
      `UPDATE ${namespace}.batch_rows SET source_id = $1::uuid
       WHERE id = $2 AND due_date IS NOT DISTINCT FROM $3::date AND source_id IS NOT DISTINCT FROM $4::uuid`,
      [sourceId, "first", null, null],
    );
    const rows = await pluginDb.query<{ id: string }>(
      pluginId,
      `SELECT r.id FROM ${namespace}.batch_rows r CROSS JOIN LATERAL unnest(ARRAY[r.id]) AS t(k)
       WHERE r.source_id IS NOT DISTINCT FROM $1::uuid
         AND EXISTS (SELECT 1 FROM jsonb_array_elements($2::jsonb) s WHERE s->>'id' = t.k)
       ORDER BY r.id`,
      [sourceId, JSON.stringify([{ id: "first" }, { id: "second" }])],
    );
    expect(rows).toEqual([{ id: "first" }, { id: "second" }]);
  });

  it("rejects mutation CTE SELECT INTO before creating a table or writing rows", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(
      pluginManifest,
      `CREATE TABLE ${namespace}.rows (id integer PRIMARY KEY);`,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);
    const escaped = `escaped_from_plugin_${randomUUID().replaceAll("-", "")}`;
    const saved = `WITH saved AS (INSERT INTO ${namespace}.rows (id) VALUES (1) RETURNING id)`;
    for (const terminal of [
      `SELECT id INTO ${escaped} FROM saved`,
      `SELECT id/**/INTO/**/"public"."${escaped}" FROM saved`,
      `SELECT id INTO TEMP TABLE "${escaped}" FROM saved`,
      `SELECT id INTO UNLOGGED TABLE public."${escaped}" FROM saved`,
      `SELECT "insert" INTO "${escaped}" FROM (SELECT id AS "insert" FROM saved) s`,
    ]) {
      await expect(pluginDb.execute(pluginId, `${saved} ${terminal}`)).rejects.toThrow(/SELECT INTO/i);
    }
    const createdTables = await db.execute(sql`
      SELECT oid FROM pg_catalog.pg_class WHERE relname = ${escaped}
    `);
    expect(Array.from(createdTables)).toEqual([]);
    expect(await pluginDb.query(pluginId, `SELECT id FROM ${namespace}.rows`)).toEqual([]);
  });

  it("rejects forbidden TABLE shorthand reads and copies against Postgres", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(pluginManifest,
      `CREATE TABLE ${namespace}.copied (id integer);
       CREATE TABLE ${namespace}.source (id integer);`,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);
    const forbidden = `forbidden_${randomUUID().replaceAll("-", "")}`;
    await db.execute(sql.raw(`CREATE TABLE public.${forbidden} (id integer)`));
    try {
      await db.execute(sql.raw(`INSERT INTO public.${forbidden} (id) VALUES (7)`));
      for (const statement of [
        `WITH stolen AS (TABLE public.${forbidden}) SELECT * FROM stolen`,
        `SELECT * FROM (TABLE/**/ONLY/**/"public"."${forbidden}") AS stolen`,
        `WITH stolen AS (TABLE ${forbidden}) SELECT * FROM stolen`,
      ]) {
        await expect(pluginDb.query(pluginId, statement)).rejects.toThrow(/schema|whitelisted|fully qualified/i);
      }
      for (const statement of [
        `WITH stolen AS (TABLE public.${forbidden}) INSERT INTO ${namespace}.copied SELECT * FROM stolen`,
        `INSERT INTO ${namespace}.copied TABLE public.${forbidden}`,
        `INSERT INTO ${namespace}.copied (TABLE/**/ONLY/**/"public"."${forbidden}")`,
        `WITH stolen AS (TABLE ${forbidden}) INSERT INTO ${namespace}.copied TABLE stolen`,
      ]) {
        await expect(pluginDb.execute(pluginId, statement)).rejects.toThrow(/schema|fully qualified/i);
      }
      expect(await pluginDb.query(pluginId, `SELECT id FROM ${namespace}.copied`)).toEqual([]);
      await pluginDb.execute(pluginId, `INSERT INTO ${namespace}.source (id) VALUES (1)`);
      await pluginDb.execute(pluginId, `WITH source AS (TABLE ${namespace}.source) INSERT INTO ${namespace}.copied TABLE source`);
      expect(await pluginDb.query(pluginId, `WITH copied AS (TABLE ${namespace}.copied) SELECT id FROM copied`))
        .toEqual([{ id: 1 }]);
    } finally {
      await db.execute(sql.raw(`DROP TABLE public.${forbidden}`));
    }
  });

  it("rejects migration attachment and existing partitioned write targets", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(pluginManifest,
      `CREATE TABLE ${namespace}.proxy (id integer, label text) PARTITION BY LIST (id);`,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);
    const external = `external_partition_${randomUUID().replaceAll("-", "")}`;
    await db.execute(sql.raw(`CREATE TABLE public.${external} (id integer, label text)`));
    try {
      await db.execute(sql.raw(`INSERT INTO public.${external} (id, label) VALUES (1, 'unchanged')`));
      await writeFile(path.join(packageRoot, "migrations", "002_attach.sql"),
        `ALTER TABLE "${namespace}"."proxy" ATTACH /* outer /* inner */ trailing */ PARTITION "public"."${external}" DEFAULT;`, "utf8");
      await expect(pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot))
        .rejects.toThrow(/cannot attach or detach partitions/i);
      const attachments = await db.execute(sql`
        SELECT inhrelid FROM pg_catalog.pg_inherits
        WHERE inhparent = ${`${namespace}.proxy`}::regclass
      `);
      expect(Array.from(attachments)).toEqual([]);
      // Simulate an attachment made before this policy existed, using the
      // trusted test connection, then restore active status after the failure.
      await db.execute(sql.raw(`ALTER TABLE ${namespace}.proxy ATTACH PARTITION public.${external} DEFAULT`));
      await db.update(pluginDatabaseNamespaces).set({ status: "active" })
        .where(eq(pluginDatabaseNamespaces.pluginId, pluginId));
      await expect(pluginDb.query(pluginId, `SELECT label FROM ${namespace}.proxy`))
        .rejects.toThrow(/plugin-owned tables/i);
      await expect(pluginDb.execute(pluginId, `UPDATE ${namespace}.proxy SET label = 'changed' WHERE id = 1`))
        .rejects.toThrow(/plugin-owned tables/i);
      const rows = await db.execute(sql.raw(`SELECT label FROM public.${external} WHERE id = 1`));
      expect(Array.from(rows)).toEqual([{ label: "unchanged" }]);
      await writeFile(path.join(packageRoot, "migrations", "002_attach.sql"),
        `CREATE TABLE ${namespace}.copied AS TABLE ${namespace}.proxy;`, "utf8");
      await expect(pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot))
        .rejects.toThrow(/plugin-owned tables/i);
      await writeFile(path.join(packageRoot, "migrations", "002_attach.sql"),
        `ALTER TABLE ${namespace}.proxy ADD COLUMN escaped_column text;`, "utf8");
      await expect(pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot))
        .rejects.toThrow(/plugin-owned tables/i);
      const addedColumns = await db.execute(sql`
        SELECT attname FROM pg_catalog.pg_attribute
        WHERE attrelid = ${`public.${external}`}::regclass AND attname = 'escaped_column'
      `);
      expect(Array.from(addedColumns)).toEqual([]);
    } finally {
      await db.execute(sql.raw(`DROP TABLE public.${external}`));
    }
  });

  it("rejects inheritance migrations and existing inherited runtime relations", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(pluginManifest,
      `CREATE TABLE ${namespace}.rows (id integer, label text);`,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);
    const external = `external_parent_${randomUUID().replaceAll("-", "")}`;
    await db.execute(sql.raw(`CREATE TABLE public.${external} (id integer, label text)`));
    try {
      await db.execute(sql.raw(`INSERT INTO public.${external} (id, label) VALUES (1, 'core')`));
      await writeFile(path.join(packageRoot, "migrations", "002_inherit.sql"),
        `ALTER TABLE "${namespace}"."rows" /* outer /* inner */ trailing */ INHERIT "public"."${external}";`, "utf8");
      await expect(pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot))
        .rejects.toThrow(/inheritance/i);
      const links = await db.execute(sql`
        SELECT inhparent FROM pg_catalog.pg_inherits WHERE inhrelid = ${`${namespace}.rows`}::regclass
      `);
      expect(Array.from(links)).toEqual([]);
      await db.execute(sql.raw(`ALTER TABLE ${namespace}.rows INHERIT public.${external}`));
      await db.update(pluginDatabaseNamespaces).set({ status: "active" })
        .where(eq(pluginDatabaseNamespaces.pluginId, pluginId));
      await expect(pluginDb.execute(pluginId, `INSERT INTO ${namespace}.rows (id, label) VALUES (2, 'escaped')`))
        .rejects.toThrow(/inheritance/i);
      await expect(pluginDb.query(pluginId, `SELECT * FROM ${namespace}.rows`)).rejects.toThrow(/inheritance/i);
      const rows = await db.execute(sql.raw(`SELECT id, label FROM public.${external} ORDER BY id`));
      expect(Array.from(rows)).toEqual([{ id: 1, label: "core" }]);
      await writeFile(path.join(packageRoot, "migrations", "002_inherit.sql"),
        `CREATE TABLE ${namespace}.copied AS SELECT * FROM ${namespace}.rows;`, "utf8");
      await expect(pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot))
        .rejects.toThrow(/inheritance/i);
    } finally {
      await db.execute(sql.raw(`ALTER TABLE ${namespace}.rows NO INHERIT public.${external}`));
      await db.execute(sql.raw(`DROP TABLE public.${external}`));
    }
  });

  it("rejects SQL and resource functions before Postgres can execute them", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(pluginManifest,
      `CREATE TABLE ${namespace}.notes (body text);`,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);
    for (const call of [
      "query_to_xml('SELECT id FROM public.companies', true, true, '')",
      "query_to_xmlschema('SELECT id FROM public.companies', true, true, '')",
      "table_to_xml('public.companies'::regclass, true, true, '')",
      "table_to_xmlschema('public.companies'::regclass, true, true, '')",
      "table_to_xml_and_xmlschema('public.companies'::regclass, true, true, '')",
      "pg_read_file('PG_VERSION')", "pg_read_binary_file('PG_VERSION')", "pg_ls_dir('.')", "pg_stat_file('PG_VERSION')",
      "lo_export(0, '/missing-directory/export')", "lo_import('/missing-directory/import')",
      "set_config('paperclip.security_probe', 'changed', false)",
    ]) {
      await expect(pluginDb.query(pluginId, `SELECT ${call} AS value`)).rejects.toThrow(/function.*not allowed/i);
      await expect(pluginDb.execute(pluginId, `INSERT INTO ${namespace}.notes (body) SELECT (${call})::text`))
        .rejects.toThrow(/function.*not allowed/i);
    }
    expect(await pluginDb.query(pluginId, `SELECT body FROM ${namespace}.notes`)).toEqual([]);
    const settings = await db.execute(sql`SELECT current_setting('paperclip.security_probe', true) AS probe`);
    expect(Array.from(settings)).toEqual([{ probe: null }]);
  });

  it("rejects migration table copies and embedded mutations before Postgres changes data", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(pluginManifest,
      `CREATE TABLE ${namespace}.rows (id integer);`,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);
    const external = `migration_source_${randomUUID().replaceAll("-", "")}`;
    await db.execute(sql.raw(`CREATE TABLE public.${external} (id integer, label text)`));
    try {
      await db.execute(sql.raw(`INSERT INTO public.${external} (id, label) VALUES (1, 'unchanged')`));
      for (const body of [
        `TABLE public.${external}`,
        `TABLE /* outer /* inner */ trailing */ ${external}`,
        `SELECT e.* FROM ${namespace}.rows r, public.${external} e`,
        `WITH changed AS (UPDATE public.${external} SET label = 'changed' RETURNING id) SELECT id FROM changed`,
        `WITH changed AS (DELETE FROM public.${external} RETURNING id) SELECT id FROM changed`,
      ]) {
        await writeFile(path.join(packageRoot, "migrations", "002_copy.sql"),
          `CREATE TABLE ${namespace}.copied AS ${body};`, "utf8");
        await expect(pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot))
          .rejects.toThrow(/fully qualified|whitelisted|data-changing/i);
        const copies = await db.execute(sql`SELECT to_regclass(${`${namespace}.copied`}) AS relation`);
        expect(Array.from(copies)).toEqual([{ relation: null }]);
      }
      const original = await db.execute(sql.raw(`SELECT id, label FROM public.${external}`));
      expect(Array.from(original)).toEqual([{ id: 1, label: "unchanged" }]);
    } finally {
      await db.execute(sql.raw(`DROP TABLE public.${external}`));
    }
  });

  it("checks migration read sources in the same transaction as their creation", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(pluginManifest,
      `CREATE TABLE ${namespace}.source (id integer);
       CREATE TABLE ${namespace}.copied AS TABLE ${namespace}.source;`,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);
    expect(await pluginDb.query(pluginId, `SELECT id FROM ${namespace}.copied`)).toEqual([]);
  });

  it("rejects existing foreign tables in runtime and migration read sources", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(pluginManifest,
      `CREATE TABLE ${namespace}.rows (id integer);`,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);
    const suffix = randomUUID().replaceAll("-", "");
    const wrapper = `test_wrapper_${suffix}`;
    const foreignServer = `test_server_${suffix}`;
    await db.execute(sql.raw(`CREATE FOREIGN DATA WRAPPER ${wrapper} NO HANDLER NO VALIDATOR`));
    await db.execute(sql.raw(`CREATE SERVER ${foreignServer} FOREIGN DATA WRAPPER ${wrapper}`));
    try {
      await db.execute(sql.raw(`CREATE FOREIGN TABLE ${namespace}.foreign_rows (id integer) SERVER ${foreignServer}`));
      await expect(pluginDb.query(pluginId, `SELECT id FROM ${namespace}.foreign_rows`))
        .rejects.toThrow(/plugin-owned tables/i);
      await expect(pluginDb.execute(pluginId, `INSERT INTO ${namespace}.rows SELECT id FROM ${namespace}.foreign_rows`))
        .rejects.toThrow(/plugin-owned tables/i);
      await writeFile(path.join(packageRoot, "migrations", "002_copy.sql"),
        `CREATE TABLE ${namespace}.copied AS TABLE ${namespace}.foreign_rows;`, "utf8");
      await expect(pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot))
        .rejects.toThrow(/plugin-owned tables/i);
      const copies = await db.execute(sql`SELECT to_regclass(${`${namespace}.copied`}) AS relation`);
      expect(Array.from(copies)).toEqual([{ relation: null }]);
    } finally {
      await db.execute(sql.raw(`DROP FOREIGN TABLE IF EXISTS ${namespace}.foreign_rows`));
      await db.execute(sql.raw(`DROP SERVER ${foreignServer}`));
      await db.execute(sql.raw(`DROP FOREIGN DATA WRAPPER ${wrapper}`));
    }
  });

  it("rejects legacy triggers, rules, and unsafe stored expressions", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(pluginManifest,
      `CREATE TABLE ${namespace}.rows (id integer, body text);`,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);
    const external = `callback_target_${randomUUID().replaceAll("-", "")}`;
    await db.execute(sql.raw(`CREATE TABLE public.${external} (id integer, label text)`));
    try {
      await db.execute(sql.raw(`INSERT INTO public.${external} (id, label) VALUES (1, 'unchanged')`));
      await db.execute(sql.raw(`CREATE FUNCTION ${namespace}.legacy_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN UPDATE public.${external} SET label = 'changed'; RETURN NEW; END $$`));
      await db.execute(sql.raw(`CREATE TRIGGER relay BEFORE INSERT ON ${namespace}.rows
        FOR EACH ROW EXECUTE FUNCTION ${namespace}.legacy_trigger()`));
      await expect(pluginDb.execute(pluginId, `INSERT INTO ${namespace}.rows (id) VALUES (1)`))
        .rejects.toThrow(/user-defined triggers/i);
      await expect(pluginDb.query(pluginId, `SELECT id FROM ${namespace}.rows`))
        .rejects.toThrow(/user-defined triggers/i);
      await db.execute(sql.raw(`DROP TRIGGER relay ON ${namespace}.rows`));
      await db.execute(sql.raw(`CREATE RULE relay AS ON INSERT TO ${namespace}.rows
        DO ALSO UPDATE public.${external} SET label = 'changed'`));
      await expect(pluginDb.execute(pluginId, `INSERT INTO ${namespace}.rows (id) VALUES (1)`))
        .rejects.toThrow(/rewrite rules/i);
      await db.execute(sql.raw(`DROP RULE relay ON ${namespace}.rows`));
      await db.execute(sql.raw(`ALTER TABLE ${namespace}.rows ALTER COLUMN body SET DEFAULT
        query_to_xml('SELECT label FROM public.${external}', true, true, '')::text`));
      await expect(pluginDb.execute(pluginId, `INSERT INTO ${namespace}.rows (id) VALUES (1)`))
        .rejects.toThrow(/function.*query_to_xml.*not allowed/i);
      expect(await pluginDb.query(pluginId, `SELECT body FROM ${namespace}.rows`)).toEqual([]);
      await db.execute(sql.raw(`ALTER TABLE ${namespace}.rows ALTER COLUMN body DROP DEFAULT`));
      await db.execute(sql.raw(`CREATE FUNCTION ${namespace}.legacy_value(integer) RETURNS text
        LANGUAGE sql IMMUTABLE AS $$ SELECT label FROM public.${external} LIMIT 1 $$`));
      for (const [setup, cleanup] of [
        [`ALTER TABLE ${namespace}.rows ADD CONSTRAINT legacy_check CHECK (${namespace}.legacy_value(id) IS NOT NULL)`,
          `ALTER TABLE ${namespace}.rows DROP CONSTRAINT legacy_check`],
        [`ALTER TABLE ${namespace}.rows ADD COLUMN generated text GENERATED ALWAYS AS (${namespace}.legacy_value(id)) STORED`,
          `ALTER TABLE ${namespace}.rows DROP COLUMN generated`],
        [`CREATE INDEX legacy_idx ON ${namespace}.rows (${namespace}.legacy_value(id))`,
          `DROP INDEX ${namespace}.legacy_idx`],
        [`CREATE INDEX legacy_idx ON ${namespace}.rows (id) WHERE ${namespace}.legacy_value(id) IS NOT NULL`,
          `DROP INDEX ${namespace}.legacy_idx`],
      ]) {
        await db.execute(sql.raw(setup!));
        await expect(pluginDb.execute(pluginId, `INSERT INTO ${namespace}.rows (id, body) VALUES (1, 'safe')`))
          .rejects.toThrow(/function.*legacy_value.*not allowed/i);
        await db.execute(sql.raw(cleanup!));
      }
      expect(await pluginDb.query(pluginId, `SELECT id FROM ${namespace}.rows`)).toEqual([]);
      const original = await db.execute(sql.raw(`SELECT label FROM public.${external} WHERE id = 1`));
      expect(Array.from(original)).toEqual([{ label: "unchanged" }]);
    } finally {
      await db.execute(sql.raw(`DROP TABLE public.${external}`));
    }
  });

  it("rejects file and large-object function fallback through PostgreSQL field notation", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(pluginManifest,
      `CREATE TABLE ${namespace}.field_rows (path text, body text);`,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);
    const trusted = await db.execute(sql.raw("SELECT ('PG_VERSION'::text).pg_read_file AS version"));
    expect(String(Array.from(trusted)[0]?.version)).toMatch(/^\d+\s*$/);
    const before = Array.from(await db.execute(sql.raw("SELECT count(*)::int AS count FROM pg_catalog.pg_largeobject_metadata")));
    for (const statement of [
      "SELECT ('PG_VERSION'::text).pg_read_file",
      'SELECT ((\'PG_VERSION\'::text)) /* outer /* inner */ trailing */ . "pg_read_file"',
      "SELECT ('PG_VERSION'::text).lo_import",
      'SELECT ((\'PG_VERSION\'::text))."lo_import"',
      "SELECT t.pg_read_file FROM unnest(ARRAY['PG_VERSION']) t",
      'SELECT t."lo_import" FROM unnest(ARRAY[\'PG_VERSION\']) AS t(path)',
      "SELECT (SELECT t.lo_import) FROM unnest(ARRAY['PG_VERSION']) t(path)",
    ]) {
      await expect(pluginDb.query(pluginId, statement)).rejects.toThrow(/field notation/i);
    }
    await expect(pluginDb.query(pluginId, "SELECT $1.pg_read_file", ["PG_VERSION"]))
      .rejects.toThrow(/field notation/i);
    await expect(pluginDb.execute(pluginId,
      `INSERT INTO ${namespace}.field_rows (body) SELECT (('PG_VERSION'::text).lo_import)::text`))
      .rejects.toThrow(/field notation/i);
    await db.execute(sql.raw(`ALTER TABLE ${namespace}.field_rows ALTER COLUMN body SET DEFAULT (('PG_VERSION'::text).lo_import)::text`));
    await expect(pluginDb.execute(pluginId, `INSERT INTO ${namespace}.field_rows (path) VALUES ('PG_VERSION')`))
      .rejects.toThrow(/function.*lo_import.*not allowed/i);
    expect(await pluginDb.query(pluginId, `SELECT r.path, r.body FROM ${namespace}.field_rows r`)).toEqual([]);
    await db.execute(sql.raw(`ALTER TABLE ${namespace}.field_rows ALTER COLUMN body DROP DEFAULT`));
    await db.execute(sql.raw(`ALTER TABLE ${namespace}.field_rows ADD CONSTRAINT field_check CHECK ((path::text).pg_read_file IS NOT NULL)`));
    await expect(pluginDb.execute(pluginId, `INSERT INTO ${namespace}.field_rows (path) VALUES ('PG_VERSION')`))
      .rejects.toThrow(/function.*pg_read_file.*not allowed/i);
    await db.execute(sql.raw(`ALTER TABLE ${namespace}.field_rows DROP CONSTRAINT field_check`));
    for (const statement of [
      `ALTER TABLE ${namespace}.field_rows ADD COLUMN generated text GENERATED ALWAYS AS (('PG_VERSION'::text).pg_read_file) STORED`,
      `CREATE INDEX field_idx ON ${namespace}.field_rows (((path::text).pg_read_file))`,
    ]) {
      await writeFile(path.join(packageRoot, "migrations", "002_field.sql"), `${statement};`, "utf8");
      await expect(pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot)).rejects.toThrow(/field notation/i);
    }
    const after = Array.from(await db.execute(sql.raw("SELECT count(*)::int AS count FROM pg_catalog.pg_largeobject_metadata")));
    expect(after).toEqual(before);
    await writeFile(path.join(packageRoot, "migrations", "002_field.sql"),
      `COMMENT ON TABLE ${namespace}.field_rows IS 'safe';`, "utf8");
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);
    await pluginDb.execute(pluginId, `INSERT INTO ${namespace}.field_rows (path, body) VALUES ('safe', 'ordinary column')`);
    expect(await pluginDb.query(pluginId, `SELECT r.body FROM ${namespace}.field_rows r`))
      .toEqual([{ body: "ordinary column" }]);
    expect(await pluginDb.query(pluginId, "SELECT t.path FROM unnest(ARRAY['safe']) AS t(path)"))
      .toEqual([{ path: "safe" }]);
  });

  it("executes native type modifiers in migrations, casts, and recordset declarations", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(pluginManifest,
      `CREATE TABLE ${namespace}.typed_rows (
        amount numeric(12,2), rate decimal(8,3), label varchar(255), code character(4),
        bits bit(4), flags bit varying(8), at time(3), happened timestamp(3), duration interval day to second(3)
       );
       ALTER TABLE ${namespace}.typed_rows ADD COLUMN extra character varying(20);
       ALTER TABLE ${namespace}.typed_rows ALTER COLUMN amount TYPE numeric(14,2) USING amount::numeric(14,2);`,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);
    await pluginDb.execute(pluginId,
      `INSERT INTO ${namespace}.typed_rows (amount, label) VALUES ($1::numeric(14,2), CAST($2 AS varchar(255)))`, ["12.34", "safe"]);
    expect(await pluginDb.query(pluginId, `SELECT amount::text AS amount, label FROM ${namespace}.typed_rows`))
      .toEqual([{ amount: "12.34", label: "safe" }]);
    expect(await pluginDb.query(pluginId,
      `SELECT (1::numeric(12,2))::text AS amount, CAST('abcdef' AS character varying(3)) AS label,
        ('1010'::bit(4))::text AS bits, ('101'::varbit(8))::text AS flags,
        ('12:34:56.123456'::time(3))::text AS at,
        ('2026-10-15 12:34:56.123456'::timestamp(3))::text AS happened,
        ('1 day 00:00:00.123456'::interval day to second(3))::text AS duration,
        (CAST(2 AS "pg_catalog"."numeric"(12,2)))::text AS qualified`,
    )).toEqual([{
      amount: "1.00", label: "abc", bits: "1010", flags: "101", at: "12:34:56.123",
      happened: "2026-10-15 12:34:56.123", duration: "1 day 00:00:00.123", qualified: "2.00",
    }]);
    expect(await pluginDb.query(pluginId,
      "SELECT amount::text AS amount, label FROM jsonb_to_recordset($1::jsonb) AS x(amount numeric(12,2), label varchar(3))",
      [JSON.stringify([{ amount: 1.25, label: "saf" }])],
    )).toEqual([{ amount: "1.25", label: "saf" }]);
    await expect(pluginDb.query(pluginId, "SELECT CAST(1 AS public.numeric(12,2))"))
      .rejects.toThrow(/function.*not allowed/i);
    await expect(pluginDb.query(pluginId, "SELECT numeric(12,2)"))
      .rejects.toThrow(/function.*not allowed/i);
  });

  it("blocks typed domain literals before their input checks can execute", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const auditTable = `typed_literal_audit_${suffix}`;
    const auditFunction = `record_typed_literal_${suffix}`;
    const auditDomain = `typed_literal_domain_${suffix}`;
    await db.execute(sql.raw(`CREATE TABLE public.${auditTable} (value text NOT NULL)`));
    await db.execute(sql.raw(`CREATE FUNCTION public.${auditFunction}(value text) RETURNS boolean
      LANGUAGE plpgsql VOLATILE AS $$
      BEGIN
        INSERT INTO public.${auditTable} VALUES (value);
        RETURN true;
      END
      $$`));
    await db.execute(sql.raw(
      `CREATE DOMAIN public.${auditDomain} AS text CHECK (public.${auditFunction}(VALUE))`,
    ));
    try {
      // Establish that PostgreSQL runs the domain check while evaluating this
      // typed literal, then clear the evidence before exercising the plugin API.
      await db.execute(sql.raw(`SELECT public.${auditDomain} 'direct-proof'`));
      expect(Array.from(await db.execute(sql.raw(`SELECT value FROM public.${auditTable}`))))
        .toEqual([{ value: "direct-proof" }]);
      await db.execute(sql.raw(`TRUNCATE public.${auditTable}`));

      const pluginManifest = manifest();
      const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
      const packageRoot = await createPluginPackage(pluginManifest,
        `CREATE TABLE ${namespace}.typed_literal_rows (value text);`,
      );
      const pluginId = await installPluginRecord(pluginManifest);
      const pluginDb = pluginDatabaseService(db);
      await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);

      await expect(pluginDb.query(pluginId, `SELECT public.${auditDomain} 'runtime-query'`))
        .rejects.toThrow(/type.*not allowed/i);
      await expect(pluginDb.execute(pluginId,
        `INSERT INTO ${namespace}.typed_literal_rows (value) VALUES (public.${auditDomain} 'runtime-execute')`))
        .rejects.toThrow(/type.*not allowed/i);
      await writeFile(path.join(packageRoot, "migrations", "002_typed_literal.sql"),
        `CREATE TABLE ${namespace}.typed_literal_default (
          value text DEFAULT public.${auditDomain} 'migration-default'
        );`, "utf8");
      await expect(pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot))
        .rejects.toThrow(/type.*not allowed/i);

      expect(Array.from(await db.execute(sql.raw(`SELECT value FROM public.${auditTable}`))))
        .toEqual([]);
      expect(Array.from(await db.execute(sql`
        SELECT to_regclass(${`${namespace}.typed_literal_default`}) AS relation
      `))).toEqual([{ relation: null }]);
    } finally {
      await db.execute(sql.raw(`DROP DOMAIN IF EXISTS public.${auditDomain}`));
      await db.execute(sql.raw(`DROP FUNCTION IF EXISTS public.${auditFunction}(text)`));
      await db.execute(sql.raw(`DROP TABLE IF EXISTS public.${auditTable}`));
    }
  });

  it("reads serial tables and restricts default sequence advancement to namespace sequences", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(pluginManifest,
      `CREATE TABLE ${namespace}.serial_rows (id serial PRIMARY KEY, label text);
       CREATE INDEX serial_label_idx ON ${namespace}.serial_rows (label);`,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);
    expect(await pluginDb.query(pluginId, `SELECT id FROM ${namespace}.serial_rows`)).toEqual([]);
    await pluginDb.execute(pluginId, `INSERT INTO ${namespace}.serial_rows (label) VALUES ($1)`, ["safe"]);
    expect(await pluginDb.query(pluginId, `SELECT id, label FROM ${namespace}.serial_rows`))
      .toEqual([{ id: 1, label: "safe" }]);
    const external = `external_sequence_${randomUUID().replaceAll("-", "")}`;
    await db.execute(sql.raw(`CREATE SEQUENCE public.${external}`));
    try {
      for (const expression of [
        `nextval('public.${external}'::regclass)`,
        `nextval(('public.' || '${external}')::text)`,
      ]) {
        await db.execute(sql.raw(`ALTER TABLE ${namespace}.serial_rows ALTER COLUMN id SET DEFAULT ${expression}`));
        expect(await pluginDb.query(pluginId, `SELECT id FROM ${namespace}.serial_rows`)).toEqual([{ id: 1 }]);
        await expect(pluginDb.execute(pluginId, `INSERT INTO ${namespace}.serial_rows (label) VALUES ('blocked')`))
          .rejects.toThrow(/ordinary sequence|function.*nextval.*not allowed/i);
        expect(Array.from(await db.execute(sql.raw(`SELECT last_value::text AS value, is_called FROM public.${external}`))))
          .toEqual([{ value: "1", is_called: false }]);
      }
      await expect(pluginDb.query(pluginId, `SELECT nextval('${namespace}.serial_rows_id_seq'::regclass)`))
        .rejects.toThrow(/function.*nextval.*not allowed/i);
    } finally {
      await db.execute(sql.raw(`ALTER TABLE ${namespace}.serial_rows ALTER COLUMN id DROP DEFAULT`));
      await db.execute(sql.raw(`DROP SEQUENCE public.${external}`));
    }
  });

  it("allows safe stored defaults, generated values, checks, and indexes", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(pluginManifest,
      `CREATE TABLE ${namespace}.rows (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), body text NOT NULL,
        normalized text GENERATED ALWAYS AS (lower(body)) STORED,
        CHECK (length(body) > 0)
       );
       CREATE INDEX rows_body_idx ON ${namespace}.rows (lower(body)) WHERE length(body) > 0;`,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);
    await pluginDb.execute(pluginId, `INSERT INTO ${namespace}.rows (body) VALUES ($1)`, ["SAFE"]);
    expect(await pluginDb.query(pluginId, `SELECT body, normalized FROM ${namespace}.rows`))
      .toEqual([{ body: "SAFE", normalized: "safe" }]);
  });

  it("rejects Unicode escape relation and function prefixes against Postgres", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(pluginManifest,
      `CREATE TABLE ${namespace}.copied (id integer);`,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);
    const external = `unicode_source_${randomUUID().replaceAll("-", "")}`;
    await db.execute(sql.raw(`CREATE TABLE public.${external} (id integer)`));
    await db.execute(sql.raw('CREATE TABLE public."\u212a" (id integer)'));
    try {
      await db.execute(sql.raw(`INSERT INTO public.${external} (id) VALUES (7)`));
      await db.execute(sql.raw('INSERT INTO public."\u212a" (id) VALUES (8)'));
      const source = `U&"p!0075blic" UESCAPE '!' ."${external}"`;
      const trusted = await db.execute(sql.raw(`SELECT id FROM ${source}`));
      expect(Array.from(trusted)).toEqual([{ id: 7 }]);
      const unicodeName = await db.execute(sql.raw('WITH k AS (SELECT 1) SELECT id FROM \u212a'));
      expect(Array.from(unicodeName)).toEqual([{ id: 8 }]);
      for (const statement of [
        `WITH u AS (SELECT 1) SELECT id FROM U&"public"."${external}"`,
        `WITH u AS (SELECT 1) SELECT id FROM u&"public"."${external}"`,
        `SELECT id FROM /* outer /* inner */ trailing */ ${source}`,
        `SELECT id FROM "public".U&"${external}"`,
        String.raw`SELECT U&"pg_\0072ead_file"('PG_VERSION')`,
      ]) {
        await expect(pluginDb.query(pluginId, statement)).rejects.toThrow(/Unicode escape quoted identifiers/i);
      }
      await expect(pluginDb.query(pluginId, 'WITH k AS (SELECT 1) SELECT id FROM \u212a'))
        .rejects.toThrow(/fully qualified/i);
      await expect(pluginDb.execute(pluginId,
        `WITH u AS (SELECT 1) INSERT INTO ${namespace}.copied SELECT id FROM U&"public"."${external}"`))
        .rejects.toThrow(/Unicode escape quoted identifiers/i);
      expect(await pluginDb.query(pluginId, `SELECT id FROM ${namespace}.copied`)).toEqual([]);
      await writeFile(path.join(packageRoot, "migrations", "002_copy.sql"),
        `CREATE TABLE ${namespace}.escaped AS TABLE ${source};`, "utf8");
      await expect(pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot))
        .rejects.toThrow(/Unicode escape quoted identifiers/i);
      const created = await db.execute(sql`SELECT to_regclass(${`${namespace}.escaped`}) AS relation`);
      expect(Array.from(created)).toEqual([{ relation: null }]);
    } finally {
      await db.execute(sql.raw(`DROP TABLE public.${external}`));
      await db.execute(sql.raw('DROP TABLE public."\u212a"'));
    }
  });

  it("preserves PostgreSQL string prefixes and Unicode dollar tags", async () => {
    const pluginManifest = manifest();
    const packageRoot = await createPluginPackage(pluginManifest,
      `CREATE TABLE ${derivePluginDatabaseNamespace(pluginManifest.id)}.rows (id integer);`,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);
    const rows = await pluginDb.query(pluginId,
      String.raw`SELECT E'it\'s literal' AS escaped, U&'d\0061ta' AS unicode_text,
        B'01'::text AS bits, X'FF'::text AS hex, $` + "\u00e9" + `$TABLE public.agents; 'quote' /* comment */$` + "\u00e9" + "$ AS dollar",
    );
    expect(rows).toEqual([{
      escaped: "it's literal", unicode_text: "data", bits: "01", hex: "11111111",
      dollar: "TABLE public.agents; 'quote' /* comment */",
    }]);
  });

  it("executes conflict updates with arbitrary whitespace and comments", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(pluginManifest,
      `CREATE TABLE ${namespace}.rows (id integer PRIMARY KEY, label text);
       CREATE TABLE ${namespace}.outbox (id integer PRIMARY KEY);`,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);
    for (const [index, separator] of [" ", "  ", "\n    ", "/**/", " /* outer /* inner */ trailing */ ", "-- comment\n "].entries()) {
      const label = `value-${index}`;
      await pluginDb.execute(pluginId,
        `INSERT INTO ${namespace}.rows (id, label) VALUES (1, $1)
         ON CONFLICT (id) DO${separator}UPDATE SET label = EXCLUDED.label`, [label]);
      expect(await pluginDb.query(pluginId, `SELECT label FROM ${namespace}.rows WHERE id = 1`))
        .toEqual([{ label }]);
    }
    await pluginDb.execute(pluginId,
      `WITH changed AS (UPDATE ONLY ${namespace}.rows AS r SET label = $1 WHERE id = 1 RETURNING id)
       INSERT INTO ${namespace}.outbox SELECT id FROM changed ON CONFLICT (id) DO\n    UPDATE SET id = EXCLUDED.id`, ["nested"]);
    expect(await pluginDb.query(pluginId, `SELECT label FROM ${namespace}.rows WHERE id = 1`))
      .toEqual([{ label: "nested" }]);
    const external = `conflict_source_${randomUUID().replaceAll("-", "")}`;
    await db.execute(sql.raw(`CREATE TABLE public.${external} (id integer, label text)`));
    try {
      await db.execute(sql.raw(`INSERT INTO public.${external} VALUES (1, 'unchanged')`));
      await expect(pluginDb.execute(pluginId,
        `WITH changed AS (UPDATE public.${external} SET label = 'changed' RETURNING id)
         INSERT INTO ${namespace}.outbox SELECT id FROM changed ON CONFLICT (id) DO/**/UPDATE SET id = EXCLUDED.id`))
        .rejects.toThrow(/namespace/i);
      expect(Array.from(await db.execute(sql.raw(`SELECT label FROM public.${external}`))))
        .toEqual([{ label: "unchanged" }]);
    } finally {
      await db.execute(sql.raw(`DROP TABLE public.${external}`));
    }
  });

  it("rejects migration relocation and public comments before changing metadata", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const name = `movable_${randomUUID().replaceAll("-", "")}`;
    const packageRoot = await createPluginPackage(pluginManifest,
      `CREATE TABLE ${namespace}.${name} (id integer, label text);`,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);
    const external = `comment_target_${randomUUID().replaceAll("-", "")}`;
    await db.execute(sql.raw(`CREATE TABLE public.${external} (id integer, label text)`));
    try {
      await db.execute(sql.raw(`COMMENT ON COLUMN public.${external}.label IS 'original'`));
      for (const statement of [
        `ALTER TABLE "${namespace}"."${name}" SET /* outer /* inner */ trailing */ SCHEMA "public"`,
        `COMMENT ON COLUMN "public"."${external}"."label" IS 'changed'`,
        `COMMENT /* outer /* inner */ trailing */ ON COLUMN public.${external}.label IS 'changed'`,
      ]) {
        await writeFile(path.join(packageRoot, "migrations", "002_escape.sql"), `${statement};`, "utf8");
        await expect(pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot))
          .rejects.toThrow(/cannot move objects between schemas|comments.*namespace/i);
      }
      const locations = await db.execute(sql`
        SELECT to_regclass(${`${namespace}.${name}`}) IS NOT NULL AS inside,
          to_regclass(${`public.${name}`}) AS outside
      `);
      expect(Array.from(locations)).toEqual([{ inside: true, outside: null }]);
      const comments = await db.execute(sql`
        SELECT col_description(attrelid, attnum) AS comment FROM pg_catalog.pg_attribute
        WHERE attrelid = ${`public.${external}`}::regclass AND attname = 'label'
      `);
      expect(Array.from(comments)).toEqual([{ comment: "original" }]);
      await writeFile(path.join(packageRoot, "migrations", "002_escape.sql"),
        `COMMENT ON TABLE ${namespace}.${name} IS 'own table';
         COMMENT ON COLUMN ${namespace}.${name}.label IS 'own column';`, "utf8");
      await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);
    } finally {
      await db.execute(sql.raw(`DROP TABLE public.${external}`));
    }
  });

  it("rejects administrative DDL and public index renames before Postgres changes objects", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(pluginManifest,
      `CREATE TABLE ${namespace}.rows (id integer);`,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);
    const suffix = randomUUID().replaceAll("-", "");
    const external = `admin_target_${suffix}`;
    const indexName = `admin_index_${suffix}`;
    const roleName = `from ${namespace}.rows`;
    await db.execute(sql.raw(`CREATE TABLE public.${external} (id integer)`));
    await db.execute(sql.raw(`CREATE INDEX ${indexName} ON public.${external} (id)`));
    try {
      for (const statement of [
        `CREATE ROLE "${roleName}" SUPERUSER LOGIN`,
        `ALTER INDEX public.${indexName} RENAME TO "from ${namespace}.rows"`,
        `CREATE INDEX "from ${namespace}.rows" ON public.${external} (id)`,
      ]) {
        await writeFile(path.join(packageRoot, "migrations", "002_escape.sql"), `${statement};`, "utf8");
        await expect(pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot))
          .rejects.toThrow(/only support|outside namespace/i);
      }
      const roles = await db.execute(sql`SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ${roleName}`);
      expect(Array.from(roles)).toEqual([]);
      const indexes = await db.execute(sql`
        SELECT c.relname FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
        WHERE i.indrelid = ${`public.${external}`}::regclass
      `);
      expect(Array.from(indexes)).toEqual([{ relname: indexName }]);
    } finally {
      await db.execute(sql.raw(`DROP TABLE public.${external}`));
      await db.execute(sql.raw(`DROP ROLE IF EXISTS "${roleName}"`));
    }
  });

  it("rejects external identity sequences before CREATE and ALTER produce objects", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const suffix = randomUUID().replaceAll("-", "");
    const plain = `identity_plain_${suffix}`;
    const existing = `identity_existing_${suffix}`;
    const created = `identity_new_${suffix}`;
    const escaped = `escaped_identity_${suffix}`;
    const packageRoot = await createPluginPackage(pluginManifest,
      `CREATE TABLE ${namespace}.${plain} (id integer NOT NULL, label text);
       CREATE TABLE ${namespace}.${existing} (id integer GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME ${namespace}.existing_identity_seq), label text);`,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);
    // PostgreSQL resolves identity sequence ownership using the sequence's
    // schema. Matching external tables make each escape executable on its own.
    for (const name of [plain, existing, created]) {
      await db.execute(sql.raw(`CREATE TABLE public.${name} (id integer NOT NULL)`));
    }
    try {
      for (const statement of [
        `CREATE TABLE ${namespace}.${created} (id integer GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME public.${escaped}))`,
        `CREATE TABLE "${namespace}"."${created}" (id integer GENERATED BY DEFAULT AS IDENTITY (sequence /* outer /* inner */ trailing */ name "public"."${escaped}"))`,
        `ALTER TABLE ${namespace}.${plain} ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME public.${escaped})`,
        `ALTER TABLE ${namespace}.${existing} ALTER COLUMN id SET SEQUENCE/**/NAME "public"."${escaped}"`,
      ]) {
        await writeFile(path.join(packageRoot, "migrations", "002_escape.sql"), `${statement};`, "utf8");
        await expect(pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot))
          .rejects.toThrow(/outside namespace/i);
        const objects = await db.execute(sql`
          SELECT to_regclass(${`public.${escaped}`}) AS sequence,
            to_regclass(${`${namespace}.${created}`}) AS copied_table
        `);
        expect(Array.from(objects)).toEqual([{ sequence: null, copied_table: null }]);
      }
      await writeFile(path.join(packageRoot, "migrations", "002_escape.sql"),
        `ALTER TABLE ${namespace}.${plain} ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME ${namespace}.plain_identity_seq);
         ALTER TABLE ${namespace}.${plain} ALTER COLUMN id SET GENERATED BY DEFAULT;
         ALTER TABLE ${namespace}.${plain} ALTER COLUMN label SET STORAGE EXTERNAL;
         CREATE TABLE ${namespace}.${created} (id integer GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME ${namespace}.created_identity_seq), label text);`, "utf8");
      await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);
      for (const name of [plain, existing, created]) {
        await pluginDb.execute(pluginId, `INSERT INTO ${namespace}.${name} (label) VALUES ($1)`, ["safe"]);
        expect(await pluginDb.query(pluginId, `SELECT id, label FROM ${namespace}.${name}`))
          .toEqual([{ id: 1, label: "safe" }]);
      }
    } finally {
      for (const name of [plain, existing, created]) {
        await db.execute(sql.raw(`DROP TABLE public.${name} CASCADE`));
      }
      await db.execute(sql.raw(`DROP SEQUENCE IF EXISTS public.${escaped}`));
    }
  });

  it("rejects nested storage destinations and access methods before objects are created", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(pluginManifest,
      `CREATE TABLE ${namespace}.rows (id integer NOT NULL);`,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);
    for (const statement of [
      `CREATE TABLE ${namespace}.escaped (id integer) TABLESPACE pg_default`,
      `CREATE TABLE ${namespace}.escaped (id integer PRIMARY KEY USING INDEX TABLESPACE pg_default)`,
      `CREATE INDEX escaped_idx ON ${namespace}.rows (id) TABLESPACE pg_default`,
      `ALTER TABLE ${namespace}.rows ADD CONSTRAINT escaped_pk PRIMARY KEY (id) USING INDEX TABLESPACE pg_default`,
      `CREATE TABLE ${namespace}.escaped (id integer) USING heap`,
      `CREATE INDEX escaped_idx ON ${namespace}.rows USING /* outer /* inner */ trailing */ btree (id)`,
      `CREATE TABLE ${namespace}.escaped (LIKE ${namespace}.rows INCLUDING ALL)`,
    ]) {
      await writeFile(path.join(packageRoot, "migrations", "002_escape.sql"), `${statement};`, "utf8");
      await expect(pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot))
        .rejects.toThrow(/tablespaces|access methods|clone table definitions/i);
    }
    const objects = await db.execute(sql`
      SELECT to_regclass(${`${namespace}.escaped`}) AS escaped_table,
        to_regclass(${`${namespace}.escaped_idx`}) AS escaped_index,
        to_regclass(${`${namespace}.escaped_pk`}) AS escaped_constraint_index
    `);
    expect(Array.from(objects)).toEqual([{ escaped_table: null, escaped_index: null, escaped_constraint_index: null }]);
  });

  it("preserves SQL-looking quoted identifiers without treating them as references", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(pluginManifest,
      `CREATE TABLE ${namespace}."from public.agents" ("join public.issues" text);
       CREATE INDEX "from public.issues" ON ${namespace}."from public.agents" ("join public.issues");`,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);
    await pluginDb.execute(pluginId,
      `INSERT INTO ${namespace}."from public.agents" ("join public.issues") VALUES ($1)`, ["safe"]);
    expect(await pluginDb.query(pluginId,
      `SELECT "join public.issues" AS value FROM ${namespace}."from public.agents"`))
      .toEqual([{ value: "safe" }]);
  });

  it("rejects runtime writes to public core tables", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(
      pluginManifest,
      `CREATE TABLE ${namespace}.notes (id uuid PRIMARY KEY, body text NOT NULL);`,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);

    await expect(
      pluginDb.execute(pluginId, "UPDATE public.issues SET title = $1", ["bad"]),
    ).rejects.toThrow(/plugin namespace/i);
  });

  it("rejects runtime writes through an existing plugin-owned view", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(
      pluginManifest,
      `CREATE TABLE ${namespace}.notes (id uuid PRIMARY KEY, body text NOT NULL);`,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "TST",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Original title",
      status: "todo",
      priority: "medium",
      identifier: "TST-2",
    });

    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);
    await db.execute(sql.raw(
      `CREATE VIEW ${namespace}.issue_proxy AS SELECT id, title FROM public.issues`,
    ));

    await expect(
      pluginDb.execute(
        pluginId,
        `UPDATE ${namespace}.issue_proxy SET title = $1 WHERE id = $2`,
        ["Changed through view", issueId],
      ),
    ).rejects.toThrow(/plugin-owned tables/i);
    await expect(pluginDb.query(pluginId, `SELECT id, title FROM ${namespace}.issue_proxy`))
      .rejects.toThrow(/plugin-owned tables/i);
    await expect(pluginDb.execute(pluginId,
      `INSERT INTO ${namespace}.notes (id, body) SELECT id, title FROM ${namespace}.issue_proxy`))
      .rejects.toThrow(/plugin-owned tables/i);
    await writeFile(path.join(packageRoot, "migrations", "002_copy_view.sql"),
      `CREATE TABLE ${namespace}.copied AS TABLE ${namespace}.issue_proxy;`, "utf8");
    await expect(pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot))
      .rejects.toThrow(/plugin-owned tables/i);
    const copies = await db.execute(sql`SELECT to_regclass(${`${namespace}.copied`}) AS relation`);
    expect(Array.from(copies)).toEqual([{ relation: null }]);

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.title).toBe("Original title");
  });

  it("records a failed migration when SQL escapes the plugin namespace", async () => {
    const pluginManifest = manifest("paperclip.escape");
    const packageRoot = await createPluginPackage(
      pluginManifest,
      "CREATE TABLE public.plugin_escape (id uuid PRIMARY KEY);",
    );
    const pluginId = await installPluginRecord(pluginManifest);

    await expect(
      pluginDatabaseService(db).applyMigrations(pluginId, pluginManifest, packageRoot),
    ).rejects.toThrow(/public\.plugin_escape|public/i);

    const [migration] = await db
      .select()
      .from(pluginMigrations)
      .where(eq(pluginMigrations.pluginId, pluginId));
    expect(migration?.status).toBe("failed");
  });

  it("rejects checksum changes for already applied migrations", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(
      pluginManifest,
      `CREATE TABLE ${namespace}.checksum_rows (id uuid PRIMARY KEY);`,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);

    await writeFile(
      path.join(packageRoot, "migrations", "001_init.sql"),
      `CREATE TABLE ${namespace}.checksum_rows (id uuid PRIMARY KEY, note text);`,
      "utf8",
    );

    await expect(pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot))
      .rejects.toThrow(/checksum mismatch/i);
  });

  it("treats a migration whose line endings changed as the same migration", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const lf = `CREATE TABLE ${namespace}.eol_rows (id uuid PRIMARY KEY);\nCREATE INDEX eol_rows_idx ON ${namespace}.eol_rows (id);\n`;
    const packageRoot = await createPluginPackage(pluginManifest, lf);
    const pluginId = await installPluginRecord(pluginManifest);
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);

    await writeFile(path.join(packageRoot, "migrations", "001_init.sql"), lf.replace(/\n/g, "\r\n"), "utf8");
    await expect(pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot)).resolves.not.toThrow();
  });
});
