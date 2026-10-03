/**
 * End-to-end check of the memory folder feature against a real, migrated
 * database: settings are stored in `memory_folders`, memories round-trip
 * through the encrypted `memories` table, and the HTTP routes drive it.
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, createDb, memories, memoryFolders } from "@paperclipai/db";
import { getTestDatabaseSupport, startTestDatabase } from "./helpers/test-postgres.js";
import { memoryFolderRoutes } from "../routes/memory-folders.js";
import { memoryFolderService } from "../services/memory-folder-sync.js";
import { memoryService } from "../services/memories.js";
import { errorHandler } from "../middleware/index.js";

const databaseSupport = await getTestDatabaseSupport();
const describeWithDatabase = databaseSupport.supported ? describe : describe.skip;

describeWithDatabase("memory folder routes against a real database", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startTestDatabase>> | null = null;
  let folder: string;
  let companyCounter = 0;

  beforeAll(async () => {
    tempDb = await startTestDatabase("paperclip-memory-folder-");
    db = createDb(tempDb.connectionString);
  }, 90_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(memoryFolders);
    await db.delete(memories);
    await db.delete(companies);
    if (folder) await fs.rm(folder, { recursive: true, force: true });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(): Promise<string> {
    const id = randomUUID();
    companyCounter += 1;
    await db.insert(companies).values({
      id,
      name: `Folder Co ${companyCounter}`,
      issuePrefix: `MF${String(companyCounter).padStart(2, "0")}`,
    });
    return id;
  }

  function appFor(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", memoryFolderRoutes(db));
    app.use(errorHandler);
    return app;
  }

  const admin = {
    type: "board",
    userId: "local-board",
    userName: "Local Board",
    userEmail: null,
    isInstanceAdmin: true,
    source: "local_implicit",
  };

  it("stores settings, exports encrypted memories as plain files, and imports edits back", async () => {
    const companyId = await seedCompany();
    folder = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-memory-folder-route-"));
    const app = appFor(admin);

    const empty = await request(app).get(`/api/companies/${companyId}/memory-folder`);
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ companyId, path: null, scheduleMinutes: null });

    const saved = await request(app)
      .put(`/api/companies/${companyId}/memory-folder`)
      .send({ path: folder, scheduleMinutes: 60 });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ path: path.normalize(folder), scheduleMinutes: 60 });

    await memoryService(db).create(
      companyId,
      { kind: "project", name: "Courier", description: null, content: "Use DHL.", agentId: null },
      { agentId: null, userId: "local-board" },
    );

    const exported = await request(app).post(`/api/companies/${companyId}/memory-folder/export`);
    expect(exported.status).toBe(200);
    expect(exported.body).toMatchObject({ mode: "export", exported: 1, error: null });

    const file = path.join(folder, "courier.md");
    const text = await fs.readFile(file, "utf8");
    expect(text).toContain("Use DHL.");
    // The file is plain text even though the database row is ciphertext.
    const [row] = await db.select().from(memories);
    expect(row.content).not.toContain("Use DHL.");

    // Edit the file by hand and add a new one, then import.
    await fs.writeFile(file, text.replace("Use DHL.", "Use FedEx."), "utf8");
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(file, future, future);
    await fs.writeFile(path.join(folder, "Opening hours.md"), "Closed Wednesdays.\n", "utf8");

    const imported = await request(app).post(`/api/companies/${companyId}/memory-folder/import`);
    expect(imported.status).toBe(200);
    expect(imported.body).toMatchObject({ mode: "import", created: 1, updated: 1, error: null });

    const after = await memoryService(db).list(companyId);
    expect(after.map((m) => [m.name, m.content]).sort()).toEqual([
      ["Courier", "Use FedEx."],
      ["Opening hours", "Closed Wednesdays."],
    ]);

    const settings = await request(app).get(`/api/companies/${companyId}/memory-folder`);
    expect(settings.body.lastResult).toMatchObject({ mode: "import", created: 1 });
    expect(settings.body.lastSyncAt).toBeTruthy();
  });

  it("rejects a relative path and a non-admin changing the folder", async () => {
    const companyId = await seedCompany();
    const app = appFor(admin);

    const relative = await request(app)
      .put(`/api/companies/${companyId}/memory-folder`)
      .send({ path: "relative/folder" });
    expect(relative.status).toBe(422);

    const member = appFor({
      type: "board",
      userId: "member-1",
      isInstanceAdmin: false,
      source: "session",
      companyIds: [companyId],
    });
    const denied = await request(member)
      .put(`/api/companies/${companyId}/memory-folder`)
      .send({ path: os.tmpdir() });
    expect(denied.status).toBe(403);
  });

  it("runs a scheduled sync only once the interval has elapsed", async () => {
    const companyId = await seedCompany();
    folder = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-memory-folder-tick-"));
    const service = memoryFolderService(db);
    await service.updateSettings(companyId, { path: folder, scheduleMinutes: 15 });

    const first = await service.tickDue(new Date());
    expect(first).toEqual({ ran: 1, failed: 0 });
    expect(await fs.readdir(folder)).toContain("MEMORY.md");

    const tooSoon = await service.tickDue(new Date(Date.now() + 5 * 60_000));
    expect(tooSoon.ran).toBe(0);

    const later = await service.tickDue(new Date(Date.now() + 16 * 60_000));
    expect(later.ran).toBe(1);
  });
});
