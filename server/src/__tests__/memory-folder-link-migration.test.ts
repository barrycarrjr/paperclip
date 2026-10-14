import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, companies, createDb, memories, memoryFolders } from "@paperclipai/db";
import { getTestDatabaseSupport, startTestDatabase } from "./helpers/test-postgres.js";
import { memoryFolderRoutes } from "../routes/memory-folders.js";
import { memoryFolderService } from "../services/memory-folder-sync.js";
import { documentLinkMigrationService } from "../services/memory-folder-link-migration.js";
import { memoryService } from "../services/memories.js";
import { errorHandler } from "../middleware/index.js";
import { decryptTextAtRest, encryptTextAtRest } from "../secrets/local-encrypted-provider.js";
import { MEMORY_FOLDER_FILE_MAX_BYTES } from "../services/memory-folder-validator.js";

const A = "DeclaredFile_A123";
const B = "DeclaredFile_B123";
const databaseSupport = await getTestDatabaseSupport();
const describeDb = databaseSupport.supported ? describe : describe.skip;

describeDb("document-link migration with real database and files", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startTestDatabase>>;
  let folder: string;
  let companyId: string;
  const actor = { agentId: null, userId: null };
  const admin = { type: "board", source: "local_implicit", isInstanceAdmin: true, userId: "local-board" };

  beforeAll(async () => {
    database = await startTestDatabase("paperclip-link-migration-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  afterEach(async () => {
    await db.delete(activityLog); await db.delete(memoryFolders); await db.delete(memories); await db.delete(companies);
    if (folder) await fs.rm(folder, { recursive: true, force: true });
  });

  async function setup() {
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Link Company", issuePrefix: "LNK" });
    folder = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-link-migration-"));
    const service = memoryFolderService(db);
    await service.updateSettings(companyId, { path: folder, driveLinkMode: true, scheduleMinutes: null });
    const target = await memoryService(db).create(companyId, { name: "Target", kind: "reference", content: "Target body", driveFileId: A }, actor);
    const source = await memoryService(db).create(companyId, { name: "Source", kind: "reference", content: "Opening paragraph.\n[Target](target.md)\nClosing paragraph." }, actor);
    await service.export(companyId);
    return { service, target, source };
  }

  function appFor(
    actorValue: Record<string, unknown> = admin,
    service = memoryFolderService(db),
  ) {
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { (req as any).actor = actorValue; next(); });
    app.use("/api", memoryFolderRoutes(db, service)); app.use(errorHandler);
    return app;
  }

  it("previews deterministically without writes, applies through HTTP, and survives export and repeated apply", async () => {
    const { service, source } = await setup();
    const sourcePath = path.join(folder, "source.md");
    const original = "\uFEFF" + (await fs.readFile(sourcePath, "utf8")).replace(/\n/g, "\r\n");
    await fs.writeFile(sourcePath, original);
    const app = appFor();
    const endpoint = `/api/companies/${companyId}/memory-folder/links`;
    const first = await request(app).get(`${endpoint}/preview`);
    const second = await request(app).get(`${endpoint}/preview`);
    expect(first.status).toBe(200);
    expect(second.body.planHash).toBe(first.body.planHash);
    expect(first.body.changes).toHaveLength(1);
    expect(first.body.changes[0]).toMatchObject({ driveFileId: A, evidence: "target_frontmatter" });
    expect(first.body.before.findings.some((finding: any) => finding.kind === "missing_drive_id")).toBe(true);
    expect(first.body.after.findings.some((finding: any) => finding.kind === "missing_drive_id")).toBe(false);
    expect(await fs.readFile(sourcePath, "utf8")).toBe(original);
    expect((await service.getSettings(companyId)).linkMigration).toBeNull();

    const applied = await request(app).post(`${endpoint}/apply`).send({ planHash: first.body.planHash });
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ status: "completed", filesChanged: 1, memoriesChanged: 1 });
    const expected = original.replace("[Target](target.md)", `[Target](target.md) (Drive-ID: ${A})`);
    expect(await fs.readFile(sourcePath, "utf8")).toBe(expected);
    expect((await memoryService(db).getById(source.id))?.content).toContain(`(Drive-ID: ${A})`);
    const again = await request(app).post(`${endpoint}/apply`).send({ planHash: first.body.planHash });
    expect(again.status).toBe(200);
    expect(again.body).toEqual(applied.body);
    expect(await fs.readFile(sourcePath, "utf8")).toBe(expected);
    await service.export(companyId);
    expect((await fs.readFile(sourcePath, "utf8")).match(/Drive-ID:/g)).toHaveLength(1);
    expect(await fs.readFile(path.join(folder, "MEMORY.md"), "utf8")).toContain(`(Drive-ID: ${A})`);
    expect((await service.previewLinks(companyId)).changes).toEqual([]);
    const [stored] = await db.select().from(memoryFolders).where(eq(memoryFolders.companyId, companyId));
    expect(stored!.linkMigration).not.toContain("Opening paragraph");
    expect(JSON.parse(decryptTextAtRest(stored!.linkMigration!))).toMatchObject({ status: "completed", items: [], evidence: [] });
    expect((await db.select().from(activityLog)).some((row) => row.action === "memory_folder.links_applied")).toBe(true);
  });

  it("refuses stale filesystem and database evidence before creating recovery state", async () => {
    const { service, source } = await setup();
    const preview = await service.previewLinks(companyId);
    const sourcePath = path.join(folder, "source.md");
    const original = await fs.readFile(sourcePath, "utf8");
    await fs.writeFile(sourcePath, original + "User edit.\n");
    await expect(service.applyLinks(companyId, preview.planHash)).rejects.toThrow(/changed since preview/);
    expect((await service.getSettings(companyId)).linkMigration).toBeNull();
    expect(await fs.readFile(sourcePath, "utf8")).toBe(original + "User edit.\n");
    await fs.writeFile(sourcePath, original);
    await memoryService(db).update(source.id, { description: "New description" });
    await expect(service.applyLinks(companyId, preview.planHash)).rejects.toThrow(/changed since preview/);
    expect((await service.getSettings(companyId)).linkMigration).toBeNull();
  });

  it("recovers a file-write interruption, blocks affected work, and permits unrelated memory edits", async () => {
    const { service, source, target } = await setup();
    const unrelated = await memoryService(db).create(companyId, { name: "Unrelated", kind: "reference", content: "Keep me" }, actor);
    const preview = await service.previewLinks(companyId);
    const failing = documentLinkMigrationService(db, { afterFileWrite: async () => { throw new Error("simulated interruption"); } });
    await expect(failing.applyLinks(companyId, preview.planHash)).rejects.toThrow("simulated interruption");
    expect((await service.getSettings(companyId)).linkMigration?.status).toBe("pending");
    expect((await memoryService(db).getById(source.id))?.content).not.toContain("Drive-ID:");
    expect(await fs.readFile(path.join(folder, "source.md"), "utf8")).toContain(`(Drive-ID: ${A})`);
    await expect(service.sync(companyId)).rejects.toThrow(/pending/);
    await expect(service.rebuildIndex(companyId)).rejects.toThrow(/pending/);
    await expect(service.updateSettings(companyId, { path: "", scheduleMinutes: null })).rejects.toThrow(/pending/);
    await expect(memoryService(db).update(source.id, { content: "Later edit" })).rejects.toThrow(/pending/);
    await expect(memoryService(db).remove(source.id)).rejects.toThrow(/pending/);
    await expect(memoryService(db).update(target.id, { driveFileId: B })).rejects.toThrow(/pending/);
    await memoryService(db).update(unrelated.id, { content: "Allowed unrelated edit" });
    expect((await service.applyLinks(companyId, preview.planHash)).status).toBe("completed");
    expect((await memoryService(db).getById(unrelated.id))?.content).toBe("Allowed unrelated edit");
    expect((await fs.readFile(path.join(folder, "source.md"), "utf8")).match(/Drive-ID:/g)).toHaveLength(1);
  });

  it("records the actor before an interrupted HTTP apply without copying note text into activity", async () => {
    const { service } = await setup();
    const preview = await service.previewLinks(companyId);
    const failing = {
      ...service,
      ...documentLinkMigrationService(db, { afterFileWrite: async () => { throw new Error("simulated HTTP interruption"); } }),
    };
    const response = await request(appFor(admin, failing))
      .post(`/api/companies/${companyId}/memory-folder/links/apply`)
      .send({ planHash: preview.planHash });

    expect(response.status).toBe(500);
    expect(await fs.readFile(path.join(folder, "source.md"), "utf8")).toContain(`(Drive-ID: ${A})`);
    expect((await service.getSettings(companyId)).linkMigration?.status).toBe("pending");
    const entries = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(entries.map((entry) => entry.action)).toEqual([
      "memory_folder.links_apply_started",
      "memory_folder.links_apply_failed",
    ]);
    expect(entries[0]).toMatchObject({ actorType: "user", actorId: "local-board" });
    const recorded = JSON.stringify(entries.map((entry) => entry.details));
    expect(recorded).toContain(preview.planHash);
    expect(recorded).not.toContain("Opening paragraph");
    expect(recorded).not.toContain("Target body");
  });

  it("does not overwrite later file edits when retrying a pending apply", async () => {
    const { service } = await setup();
    const preview = await service.previewLinks(companyId);
    const failing = documentLinkMigrationService(db, { afterFileWrite: async () => { throw new Error("interrupted"); } });
    await expect(failing.applyLinks(companyId, preview.planHash)).rejects.toThrow("interrupted");
    const sourcePath = path.join(folder, "source.md");
    const later = (await fs.readFile(sourcePath, "utf8")) + "Later operator edit.\n";
    await fs.writeFile(sourcePath, later);
    await expect(service.applyLinks(companyId, preview.planHash)).rejects.toThrow(/changed during migration/);
    expect(await fs.readFile(sourcePath, "utf8")).toBe(later);
    expect((await service.getSettings(companyId)).linkMigration?.status).toBe("pending");
  });

  it("checks earlier files again before declaring a multi-file apply completed", async () => {
    const { service, source } = await setup();
    await memoryService(db).create(companyId, { name: "Source Z", kind: "reference", content: "[Target](target.md)" }, actor);
    await service.export(companyId);
    const preview = await service.previewLinks(companyId);
    const editing = documentLinkMigrationService(db, { afterFileWrite: async (file) => {
      if (file === "source.md") await fs.appendFile(path.join(folder, "source-z.md"), "Concurrent edit.\n");
    } });
    await expect(editing.applyLinks(companyId, preview.planHash)).rejects.toThrow(/before migration completion/);
    expect((await service.getSettings(companyId)).linkMigration?.status).toBe("pending");
    expect((await memoryService(db).getById(source.id))?.content).not.toContain("Drive-ID:");
    expect(await fs.readFile(path.join(folder, "source-z.md"), "utf8")).toContain("Concurrent edit");
  });

  it("repairs paths by the existing authoritative ID and leaves ambiguous or unsupported evidence unchanged", async () => {
    const { service, source } = await setup();
    await memoryService(db).create(companyId, { name: "Other", kind: "reference", content: "Other body", driveFileId: B }, actor);
    await memoryService(db).update(source.id, { content: `[Wrong](other.md#intro "keep title") (Drive-ID: ${A})\n[Other](other.md) (Drive-ID: ${B})\n[Drive](https://drive.google.com/file/d/${A}/view)\n[[target|Wiki]]\n[Ref][t]\n[t]: target.md\n[Missing](missing.md)\n[Unknown](https://drive.google.com/file/d/UnknownFile_123/view)\n\`[Example](target.md)\`` });
    await service.export(companyId);
    const preview = await service.previewLinks(companyId);
    expect(preview.changes).toHaveLength(4);
    expect(preview.changes.map((change) => change.driveFileId)).toEqual([A, A, A, A]);
    expect(preview.skipped).toHaveLength(2);
    await service.applyLinks(companyId, preview.planHash);
    const content = (await memoryService(db).getById(source.id))!.content;
    expect(content).toContain(`[Wrong](target.md#intro "keep title") (Drive-ID: ${A})`);
    expect(content).toContain(`[Drive](target.md) (Drive-ID: ${A})`);
    expect(content).toContain(`[Wiki](target.md) (Drive-ID: ${A})`);
    expect(content).toContain(`[Ref](target.md) (Drive-ID: ${A})`);
    expect(content).toContain("[Missing](missing.md)");
    expect(content).toContain("`[Example](target.md)`");
  });

  it("requires explicit mode and keeps cross-company actors and hashes out", async () => {
    const { service } = await setup();
    const preview = await service.previewLinks(companyId);
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Other", issuePrefix: "OTH" });
    const foreign = appFor({ type: "agent", companyId: otherCompanyId, agentId: randomUUID(), isPortfolioRootAgent: true });
    expect((await request(foreign).get(`/api/companies/${companyId}/memory-folder/links/preview`)).status).toBe(403);
    expect((await request(foreign).post(`/api/companies/${companyId}/memory-folder/links/apply`).send({ planHash: preview.planHash })).status).toBe(403);
    await service.updateSettings(companyId, { path: folder, driveLinkMode: false });
    await expect(service.previewLinks(companyId)).rejects.toThrow(/Enable Drive-link mode/);
    expect((await service.getSettings(companyId)).driveLinkMode).toBe(false);
  });

  it("rejects malformed saved recovery records before writing files", async () => {
    const { service } = await setup();
    const original = await fs.readFile(path.join(folder, "source.md"), "utf8");
    await db.update(memoryFolders).set({ linkMigration: encryptTextAtRest(JSON.stringify({ version: 1, status: "completed", planHash: "a".repeat(64), items: [] })) }).where(eq(memoryFolders.companyId, companyId));
    await expect(service.applyLinks(companyId, "a".repeat(64))).rejects.toThrow(/receipt cannot be read/);
    expect(await fs.readFile(path.join(folder, "source.md"), "utf8")).toBe(original);
  });

  it("serializes a concurrent affected memory edit with durable preparation", async () => {
    const { service, source } = await setup();
    const preview = await service.previewLinks(companyId);
    let update: Promise<unknown> | null = null;
    let editError: unknown = null;
    const migrating = documentLinkMigrationService(db, {
      beforeReceiptPersist: async () => { update = memoryService(db).update(source.id, { content: "Concurrent memory edit" }).catch((error) => { editError = error; }); },
      afterReceiptPersist: async () => { await update; expect(editError).toBeInstanceOf(Error); expect((editError as Error).message).toMatch(/pending/); },
    });
    expect((await migrating.applyLinks(companyId, preview.planHash)).status).toBe("completed");
    expect((await memoryService(db).getById(source.id))?.content).not.toContain("Concurrent memory edit");
  });

  it("keeps a target memory's identity stable between prepare and apply", async () => {
    const { service, target } = await setup();
    const preview = await service.previewLinks(companyId);
    const migrating = documentLinkMigrationService(db, { afterReceiptPersist: async () => {
      await expect(memoryService(db).update(target.id, { driveFileId: B, content: "Different target" })).rejects.toThrow(/pending/);
    } });
    expect((await migrating.applyLinks(companyId, preview.planHash)).status).toBe("completed");
    expect((await memoryService(db).getById(target.id))?.driveFileId).toBe(A);
  });

  it("refuses a proposed path repair that would introduce a new orphan finding", async () => {
    const { service, source } = await setup();
    await memoryService(db).create(companyId, { name: "Other", kind: "reference", content: "Other body", driveFileId: B }, actor);
    await memoryService(db).update(source.id, { content: `[Wrong](other.md) (Drive-ID: ${A})` });
    await service.export(companyId);
    const preview = await service.previewLinks(companyId);
    expect(preview.before.findings.some((finding) => finding.kind === "orphan_note" && finding.path === "other.md")).toBe(false);
    expect(preview.after.findings.some((finding) => finding.kind === "orphan_note" && finding.path === "other.md")).toBe(true);
    const original = await fs.readFile(path.join(folder, "source.md"), "utf8");
    await expect(service.applyLinks(companyId, preview.planHash)).rejects.toThrow(/adds validation findings/);
    expect((await service.getSettings(companyId)).linkMigration).toBeNull();
    expect(await fs.readFile(path.join(folder, "source.md"), "utf8")).toBe(original);
  });

  it.each(["name", "kind", "description", "agent"] as const)("skips an edited %s header without advancing the saved source version", async (field) => {
    const { service, source } = await setup();
    const sourcePath = path.join(folder, "source.md");
    let edited = await fs.readFile(sourcePath, "utf8");
    if (field === "name") edited = edited.replace("name: Source", "name: Revised source");
    if (field === "kind") edited = edited.replace("kind: reference", "kind: feedback");
    if (field === "description") edited = edited.replace("kind: reference", "kind: reference\ndescription: Operator description");
    if (field === "agent") edited = edited.replace("kind: reference", "kind: reference\nagent: Requested agent");
    await fs.writeFile(sourcePath, edited);
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(sourcePath, future, future);
    const preview = await service.previewLinks(companyId);
    expect(preview.changes).toEqual([]);
    expect(preview.skipped).toContainEqual(expect.objectContaining({ path: "source.md", reason: expect.stringContaining("file/database evidence disagreement") }));
    expect((await service.applyLinks(companyId, preview.planHash)).memoriesChanged).toBe(0);
    expect(await fs.readFile(sourcePath, "utf8")).toBe(edited);
    expect((await memoryService(db).getById(source.id))?.updatedAt).toEqual(source.updatedAt);
    if (field !== "agent") {
      await service.sync(companyId);
      const saved = await memoryService(db).getById(source.id);
      if (field === "name") expect(saved?.name).toBe("Revised source");
      if (field === "kind") expect(saved?.kind).toBe("feedback");
      if (field === "description") expect(saved?.description).toBe("Operator description");
    }
  });

  it("compares retry effects at the saved scan time across a staleness threshold", async () => {
    const { service } = await setup();
    const sourcePath = path.join(folder, "source.md");
    const original = await fs.readFile(sourcePath, "utf8");
    await fs.writeFile(sourcePath, original.replace(/^updated: .*$/m, "updated: 2026-07-16T12:00:00.000Z"));
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-14T11:59:59.000Z"));
      const preview = await service.previewLinks(companyId);
      expect(preview.before.findings.some((finding) => finding.kind === "stale_active_note" && finding.path === "source.md")).toBe(false);
      const failing = documentLinkMigrationService(db, {
        afterReceiptPersist: async () => { vi.setSystemTime(new Date("2026-10-14T12:00:01.000Z")); },
        afterFileWrite: async () => { throw new Error("clock-crossing interruption"); },
      });
      await expect(failing.applyLinks(companyId, preview.planHash)).rejects.toThrow("clock-crossing interruption");
      expect((await service.getSettings(companyId)).linkMigration?.status).toBe("pending");
      const applied = await service.applyLinks(companyId, preview.planHash);
      expect(applied.status).toBe("completed");
      expect(applied.after?.scannedAt).toBe(applied.before.scannedAt);
      expect(applied.after?.findings.some((finding) => finding.kind === "stale_active_note" && finding.path === "source.md")).toBe(false);
      const fresh = await service.validate(companyId);
      expect(fresh.findings.some((finding) => finding.kind === "stale_active_note" && finding.path === "source.md")).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("rejects invalid UTF-8 without replacing unrelated original bytes", async () => {
    const { service } = await setup();
    const unsafePath = path.join(folder, "manual.md");
    const bytes = Buffer.concat([Buffer.from("---\nname: Manual\nkind: reference\nupdated: 2026-10-14\n---\nCaf"), Buffer.from([0xE9]), Buffer.from("\n[Target](target.md)\n")]);
    await fs.writeFile(unsafePath, bytes);
    const preview = await service.previewLinks(companyId);
    expect(preview.before.findings).toContainEqual(expect.objectContaining({ kind: "unsafe_entry", path: "manual.md" }));
    await expect(service.applyLinks(companyId, preview.planHash)).rejects.toThrow(/unsafe entries/);
    expect((await service.getSettings(companyId)).linkMigration).toBeNull();
    expect(await fs.readFile(unsafePath)).toEqual(bytes);
  });

  it("rejects a rewritten file exceeding the byte cap before saving a pending receipt", async () => {
    const { service } = await setup();
    const prefix = "---\nname: Huge\nkind: reference\nupdated: 2026-10-14\n---\n";
    const suffix = "\n[Target](target.md)\n";
    const original = prefix + "x".repeat(MEMORY_FOLDER_FILE_MAX_BYTES - Buffer.byteLength(prefix + suffix) - 2) + suffix;
    const hugePath = path.join(folder, "huge.md");
    await fs.writeFile(hugePath, original);
    expect(Buffer.byteLength(original)).toBe(MEMORY_FOLDER_FILE_MAX_BYTES - 2);
    await expect(service.previewLinks(companyId)).rejects.toThrow(/would exceed.*byte note limit/);
    await expect(service.applyLinks(companyId, "0".repeat(64))).rejects.toThrow(/would exceed.*byte note limit/);
    expect((await service.getSettings(companyId)).linkMigration).toBeNull();
    expect(await fs.readFile(hugePath, "utf8")).toBe(original);
  });

  it("migrates a valid unmatched-parenthesis title without changing its text", async () => {
    const { service, source } = await setup();
    await memoryService(db).update(source.id, { content: '[Target](target.md "why (")' });
    await service.export(companyId);
    const preview = await service.previewLinks(companyId);
    expect(preview.changes).toHaveLength(1);
    await service.applyLinks(companyId, preview.planHash);
    expect((await memoryService(db).getById(source.id))?.content).toBe(`[Target](target.md "why (") (Drive-ID: ${A})`);
  });
});
