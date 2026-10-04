import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  applyPendingMigrations,
  inspectMigrations,
  pluginEntities,
  pluginJobs,
  pluginJobRuns,
  pluginLogs,
  pluginWebhookDeliveries,
  plugins,
} from "@paperclipai/db";
import { buildHostServices, flushPluginLogBuffer } from "../services/plugin-host-services.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: vi.fn(),
        subscribe: vi.fn(),
        clear: vi.fn(),
      };
    },
  } as any;
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin tenant-isolation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("plugin tenant isolation (company_id FK)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-tenant-isolation-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(pluginEntities);
    await db.delete(pluginJobRuns);
    await db.delete(pluginJobs);
    await db.delete(pluginLogs);
    await db.delete(pluginWebhookDeliveries);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedPlugin() {
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.tenant-isolation-test",
      packageName: "@paperclipai/plugin-tenant-isolation-test",
      version: "0.0.1",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "paperclip.tenant-isolation-test",
        apiVersion: 1,
        version: "0.0.1",
        displayName: "Tenant Isolation Test",
        description: "Test plugin",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: [],
        entrypoints: { worker: "./dist/worker.js" },
      },
      status: "ready",
      installOrder: 1,
    });
    return pluginId;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Tenant ${companyId.slice(0, 6)}`,
      issuePrefix: issuePrefix(companyId),
    });
    return companyId;
  }

  it("allows NULL company_id on plugin_logs (instance-scope rows behave as before)", async () => {
    const pluginId = await seedPlugin();
    await db.insert(pluginLogs).values({
      pluginId,
      // companyId intentionally omitted — NULL means instance-scope.
      level: "info",
      message: "instance-scope log",
    });
    const rows = await db.select().from(pluginLogs).where(eq(pluginLogs.pluginId, pluginId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.companyId).toBeNull();
  });

  it("cascades plugin_logs / plugin_entities / plugin_job_runs / plugin_webhook_deliveries when the owning company is deleted", async () => {
    const pluginId = await seedPlugin();
    const companyA = await seedCompany();
    const companyB = await seedCompany();

    // Seed a job + run so we can verify plugin_job_runs cascades too.
    const jobAId = randomUUID();
    const jobBId = randomUUID();
    await db.insert(pluginJobs).values([
      { id: jobAId, pluginId, jobKey: "cron-a", schedule: "* * * * *" },
      { id: jobBId, pluginId, jobKey: "cron-b", schedule: "* * * * *" },
    ]);

    await db.insert(pluginLogs).values([
      { pluginId, companyId: companyA, level: "info", message: "A log" },
      { pluginId, companyId: companyB, level: "info", message: "B log" },
      { pluginId, level: "info", message: "instance log" },
    ]);

    await db.insert(pluginEntities).values([
      {
        pluginId,
        companyId: companyA,
        entityType: "issue",
        scopeKind: "company",
        scopeId: companyA,
        externalId: "ext-a",
      },
      {
        pluginId,
        companyId: companyB,
        entityType: "issue",
        scopeKind: "company",
        scopeId: companyB,
        externalId: "ext-b",
      },
    ]);

    await db.insert(pluginJobRuns).values([
      { jobId: jobAId, pluginId, companyId: companyA, trigger: "manual" },
      { jobId: jobBId, pluginId, companyId: companyB, trigger: "manual" },
      { jobId: jobAId, pluginId, trigger: "scheduled" },
    ]);

    await db.insert(pluginWebhookDeliveries).values([
      { pluginId, companyId: companyA, webhookKey: "wh", payload: { who: "A" } },
      { pluginId, companyId: companyB, webhookKey: "wh", payload: { who: "B" } },
      { pluginId, webhookKey: "wh", payload: { who: "instance" } },
    ]);

    // Delete company A — only A's rows should be reaped. B's and NULL-scope rows stay.
    await db.delete(companies).where(eq(companies.id, companyA));

    const logs = await db.select().from(pluginLogs);
    expect(logs.map((r) => r.companyId).sort((a, b) => String(a).localeCompare(String(b)))).toEqual(
      [companyB, null].sort((a, b) => String(a).localeCompare(String(b))),
    );

    const entities = await db.select().from(pluginEntities);
    expect(entities).toHaveLength(1);
    expect(entities[0]?.companyId).toBe(companyB);

    const runs = await db.select().from(pluginJobRuns);
    expect(runs.map((r) => r.companyId).sort((a, b) => String(a).localeCompare(String(b)))).toEqual(
      [companyB, null].sort((a, b) => String(a).localeCompare(String(b))),
    );

    const deliveries = await db.select().from(pluginWebhookDeliveries);
    expect(deliveries.map((r) => r.companyId).sort((a, b) => String(a).localeCompare(String(b)))).toEqual(
      [companyB, null].sort((a, b) => String(a).localeCompare(String(b))),
    );
  });

  it("plugin_entities unique index is scoped per company — two tenants can share (pluginId, entityType, externalId)", async () => {
    const pluginId = await seedPlugin();
    const companyA = await seedCompany();
    const companyB = await seedCompany();

    // Company A claims external id "ext-1".
    await db.insert(pluginEntities).values({
      pluginId,
      companyId: companyA,
      entityType: "page",
      scopeKind: "company",
      scopeId: companyA,
      externalId: "ext-1",
    });

    // Company B uses the SAME (pluginId, entityType, externalId) — must succeed
    // under the per-company unique index (would have collided under the old index).
    await db.insert(pluginEntities).values({
      pluginId,
      companyId: companyB,
      entityType: "page",
      scopeKind: "company",
      scopeId: companyB,
      externalId: "ext-1",
    });

    const rows = await db.select().from(pluginEntities);
    expect(rows).toHaveLength(2);

    // Re-inserting the same (companyId, pluginId, entityType, externalId) tuple
    // for company A must violate the unique constraint. Drizzle wraps the
    // underlying pg error as "Failed query: ..." — inspect the cause to confirm
    // it's the unique violation on our index (pg error code 23505).
    const err = await db
      .insert(pluginEntities)
      .values({
        pluginId,
        companyId: companyA,
        entityType: "page",
        scopeKind: "company",
        scopeId: companyA,
        externalId: "ext-1",
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(Error);
    // postgres error code 23505 = unique_violation, the constraint name is
    // not always surfaced on .cause by the driver, but the code is sufficient
    // to prove the unique index rejected the duplicate.
    const pgError = err as { code?: string; cause?: { code?: string } };
    expect(pgError.cause?.code ?? pgError.code).toBe("23505");
  });

  it("pluginRegistryService.upsertEntity scopes its lookup by companyId — never overwrites another tenant's row", async () => {
    const pluginId = await seedPlugin();
    const companyA = await seedCompany();
    const companyB = await seedCompany();

    const registry = pluginRegistryService(db);

    // Company A claims (issue, ext-shared) with title "A".
    const createdA = await registry.upsertEntity(pluginId, {
      companyId: companyA,
      entityType: "issue",
      scopeKind: "company",
      scopeId: companyA,
      externalId: "ext-shared",
      title: "A",
      status: "open",
      data: {},
    });

    // Company B upserts the SAME (entityType, externalId) tuple under its own
    // scope — must create a NEW row for B, NOT overwrite A.
    const createdB = await registry.upsertEntity(pluginId, {
      companyId: companyB,
      entityType: "issue",
      scopeKind: "company",
      scopeId: companyB,
      externalId: "ext-shared",
      title: "B",
      status: "open",
      data: {},
    });

    expect(createdA?.id).toBeTruthy();
    expect(createdB?.id).toBeTruthy();
    expect(createdA?.id).not.toBe(createdB?.id);

    // Company B updates its own row — A's row must remain untouched.
    const updatedB = await registry.upsertEntity(pluginId, {
      companyId: companyB,
      entityType: "issue",
      scopeKind: "company",
      scopeId: companyB,
      externalId: "ext-shared",
      title: "B-updated",
      status: "closed",
      data: {},
    });
    expect(updatedB?.id).toBe(createdB?.id);
    expect(updatedB?.title).toBe("B-updated");

    const rows = await db.select().from(pluginEntities);
    expect(rows).toHaveLength(2);
    const rowA = rows.find((r) => r.companyId === companyA);
    const rowB = rows.find((r) => r.companyId === companyB);
    expect(rowA?.title).toBe("A");
    expect(rowA?.status).toBe("open");
    expect(rowB?.title).toBe("B-updated");
    expect(rowB?.status).toBe("closed");

    // Instance-scope upsert (companyId = NULL) on the same tuple must also
    // create its own row, not collide with A or B.
    const createdInstance = await registry.upsertEntity(pluginId, {
      companyId: null,
      entityType: "issue",
      scopeKind: "instance",
      scopeId: null,
      externalId: "ext-shared",
      title: "instance",
      status: "open",
      data: {},
    });
    expect(createdInstance?.id).toBeTruthy();
    expect(createdInstance?.id).not.toBe(createdA?.id);
    expect(createdInstance?.id).not.toBe(createdB?.id);

    const allRows = await db.select().from(pluginEntities);
    expect(allRows).toHaveLength(3);
  });

  it("pluginRegistryService.getEntityByExternalId scopes by companyId — never returns another tenant's row", async () => {
    const pluginId = await seedPlugin();
    const companyA = await seedCompany();
    const companyB = await seedCompany();

    const registry = pluginRegistryService(db);

    await registry.upsertEntity(pluginId, {
      companyId: companyA,
      entityType: "issue",
      scopeKind: "company",
      scopeId: companyA,
      externalId: "ext-shared",
      title: "A",
      status: "open",
      data: {},
    });
    await registry.upsertEntity(pluginId, {
      companyId: companyB,
      entityType: "issue",
      scopeKind: "company",
      scopeId: companyB,
      externalId: "ext-shared",
      title: "B",
      status: "open",
      data: {},
    });
    await registry.upsertEntity(pluginId, {
      companyId: null,
      entityType: "issue",
      scopeKind: "instance",
      scopeId: null,
      externalId: "ext-shared",
      title: "instance",
      status: "open",
      data: {},
    });

    const fromA = await registry.getEntityByExternalId(pluginId, "issue", "ext-shared", companyA);
    expect(fromA?.companyId).toBe(companyA);
    expect(fromA?.title).toBe("A");

    const fromB = await registry.getEntityByExternalId(pluginId, "issue", "ext-shared", companyB);
    expect(fromB?.companyId).toBe(companyB);
    expect(fromB?.title).toBe("B");

    const fromInstance = await registry.getEntityByExternalId(pluginId, "issue", "ext-shared", null);
    expect(fromInstance?.companyId).toBeNull();
    expect(fromInstance?.title).toBe("instance");

    // Unknown tenant returns null, not another tenant's row.
    const unknown = await registry.getEntityByExternalId(
      pluginId,
      "issue",
      "ext-shared",
      randomUUID(),
    );
    expect(unknown).toBeNull();
  });

  it("pluginRegistryService.createJobRun + createWebhookDelivery persist companyId so cascade delete reaps them", async () => {
    const pluginId = await seedPlugin();
    const companyA = await seedCompany();
    const companyB = await seedCompany();

    const registry = pluginRegistryService(db);
    const jobId = randomUUID();
    await db.insert(pluginJobs).values({
      id: jobId,
      pluginId,
      jobKey: "test-job",
      schedule: "* * * * *",
    });

    const runA = await registry.createJobRun(pluginId, jobId, "manual", companyA);
    const runB = await registry.createJobRun(pluginId, jobId, "manual", companyB);
    const runInstance = await registry.createJobRun(pluginId, jobId, "scheduled", null);

    expect(runA?.companyId).toBe(companyA);
    expect(runB?.companyId).toBe(companyB);
    expect(runInstance?.companyId).toBeNull();

    const whA = await registry.createWebhookDelivery(pluginId, "wh", companyA, {
      payload: { who: "A" },
    });
    const whB = await registry.createWebhookDelivery(pluginId, "wh", companyB, {
      payload: { who: "B" },
    });
    const whInstance = await registry.createWebhookDelivery(pluginId, "wh", null, {
      payload: { who: "instance" },
    });

    expect(whA?.companyId).toBe(companyA);
    expect(whB?.companyId).toBe(companyB);
    expect(whInstance?.companyId).toBeNull();

    // Cascade: deleting company A reaps A's rows; B's and instance-scope rows stay.
    await db.delete(companies).where(eq(companies.id, companyA));

    const runs = await db.select().from(pluginJobRuns);
    expect(runs.map((r) => r.companyId).sort((a, b) => String(a).localeCompare(String(b)))).toEqual(
      [companyB, null].sort((a, b) => String(a).localeCompare(String(b))),
    );

    const deliveries = await db.select().from(pluginWebhookDeliveries);
    expect(
      deliveries.map((r) => r.companyId).sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual([companyB, null].sort((a, b) => String(a).localeCompare(String(b))));
  });

  it("buildHostServices.logger.log + flushPluginLogBuffer persist companyId so cascade delete reaps log rows", async () => {
    const pluginId = await seedPlugin();
    const companyA = await seedCompany();
    const companyB = await seedCompany();

    // Flush any leftovers from prior tests (the buffer is module-scoped).
    await flushPluginLogBuffer();
    await db.delete(pluginLogs);

    const services = buildHostServices(db, pluginId, "tenant-isolation-test", createEventBusStub());
    try {
      await services.logger.log({
        level: "info",
        message: "A log",
        companyId: companyA,
      });
      await services.logger.log({
        level: "warn",
        message: "B log",
        companyId: companyB,
      });
      await services.logger.log({
        level: "info",
        message: "instance log",
        // companyId omitted — explicit instance-scope.
      });
      await services.logger.log({
        level: "debug",
        message: "explicit-null log",
        companyId: null,
      });

      await flushPluginLogBuffer();

      const rows = await db
        .select()
        .from(pluginLogs)
        .where(eq(pluginLogs.pluginId, pluginId));
      const byMessage = new Map(rows.map((r) => [r.message, r]));
      expect(byMessage.get("A log")?.companyId).toBe(companyA);
      expect(byMessage.get("B log")?.companyId).toBe(companyB);
      expect(byMessage.get("instance log")?.companyId).toBeNull();
      expect(byMessage.get("explicit-null log")?.companyId).toBeNull();

      // Cascade: deleting company A reaps A's log row; B's + NULL rows remain.
      await db.delete(companies).where(eq(companies.id, companyA));

      const afterDelete = await db
        .select()
        .from(pluginLogs)
        .where(eq(pluginLogs.pluginId, pluginId));
      const messages = afterDelete.map((r) => r.message).sort();
      expect(messages).toEqual(["B log", "explicit-null log", "instance log"]);
    } finally {
      services.dispose();
      // Ensure no leftover entries leak into other tests.
      await flushPluginLogBuffer();
    }
  });

  it("plugin_entities deduplicates external IDs in the NULL company scope", async () => {
    const pluginId = await seedPlugin();

    // First instance-scope entity (companyId = NULL) — succeeds.
    await db.insert(pluginEntities).values({
      pluginId,
      companyId: null,
      entityType: "cron",
      scopeKind: "instance",
      scopeId: null,
      externalId: "global-cron-1",
    });

    // Second instance-scope row with the SAME (pluginId, entityType, externalId)
    // must be rejected by the instance-scope partial index.
    const err = await db
      .insert(pluginEntities)
      .values({
        pluginId,
        companyId: null,
        entityType: "cron",
        scopeKind: "instance",
        scopeId: null,
        externalId: "global-cron-1",
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(Error);
    const pgError = err as { code?: string; cause?: { code?: string } };
    expect(pgError.cause?.code ?? pgError.code).toBe("23505");
  });

  it("preserves multiple anonymous entities and filters lists by tenant", async () => {
    const pluginId = await seedPlugin();
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const registry = pluginRegistryService(db);
    const first = await registry.upsertEntity(pluginId, { companyId: companyA, entityType: "note", scopeKind: "company", scopeId: companyA });
    const second = await registry.upsertEntity(pluginId, { companyId: companyA, entityType: "note", scopeKind: "company", scopeId: companyA });
    await registry.upsertEntity(pluginId, { companyId: companyB, entityType: "note", scopeKind: "company", scopeId: companyB });
    expect(first.id).not.toBe(second.id);
    expect((await registry.listEntities(pluginId, { companyId: companyA })).map((row) => row.id).sort()).toEqual([first.id, second.id].sort());
    expect(await registry.listEntities(pluginId, { companyId: null })).toEqual([]);
  });

  it("infers legacy company scope and rejects a mismatched tenant", async () => {
    const pluginId = await seedPlugin();
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const registry = pluginRegistryService(db);
    const first = await registry.upsertEntity(pluginId, { entityType: "legacy", externalId: "same", scopeKind: "company", scopeId: companyA });
    const second = await registry.upsertEntity(pluginId, { entityType: "legacy", externalId: "same", scopeKind: "company", scopeId: companyB });
    expect(first.companyId).toBe(companyA);
    expect(second.companyId).toBe(companyB);
    expect(first.id).not.toBe(second.id);
    expect(await registry.listEntities(pluginId, { scopeKind: "company", scopeId: companyA })).toHaveLength(1);
    await expect(registry.upsertEntity(pluginId, { companyId: companyB, entityType: "legacy", externalId: "same", scopeKind: "company", scopeId: companyA })).rejects.toThrow("Entity company does not match its scope");
  });

  it("upgrades a database that already applied memory folders and backfills existing entity ownership", async () => {
    const pluginId = await seedPlugin();
    const companyId = await seedCompany();
    const migration = "0105_plugin_company_id_tenant_isolation.sql";
    const content = await readFile(new URL(`../../../packages/db/src/migrations/${migration}`, import.meta.url), "utf8");
    const hash = createHash("sha256").update(content).digest("hex");

    // Reconstruct the published pre-security schema while retaining its migration history.
    await db.execute(sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = ${hash}`);
    await db.execute(sql`DROP INDEX "plugin_entities_instance_external_idx"`);
    await db.execute(sql`ALTER TABLE "plugin_entities" DROP COLUMN "company_id" CASCADE`);
    await db.execute(sql`ALTER TABLE "plugin_job_runs" DROP COLUMN "company_id" CASCADE`);
    await db.execute(sql`ALTER TABLE "plugin_logs" DROP COLUMN "company_id" CASCADE`);
    await db.execute(sql`ALTER TABLE "plugin_webhook_deliveries" DROP COLUMN "company_id" CASCADE`);
    await db.execute(sql`CREATE UNIQUE INDEX "plugin_entities_external_idx" ON "plugin_entities" ("plugin_id", "entity_type", "external_id")`);
    await db.execute(sql`INSERT INTO "plugin_entities" ("plugin_id", "entity_type", "scope_kind", "scope_id", "external_id") VALUES (${pluginId}, 'legacy', 'company', ${companyId}, 'before-security-upgrade')`);

    const pending = await inspectMigrations(tempDb!.connectionString);
    expect(pending).toMatchObject({ status: "needsMigrations", pendingMigrations: [migration] });
    await applyPendingMigrations(tempDb!.connectionString);
    expect((await inspectMigrations(tempDb!.connectionString)).status).toBe("upToDate");
    const [entity] = await db.select().from(pluginEntities).where(eq(pluginEntities.pluginId, pluginId));
    expect(entity?.companyId).toBe(companyId);
    const folders = await db.execute(sql`SELECT to_regclass('public.memory_folders') AS name`);
    expect(folders[0]?.name).toBe("memory_folders");
  });
});
