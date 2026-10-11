import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companySkills,
  createDb,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companySkillService } from "../services/company-skills.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company skill delete tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const FOLDER_OPEN = { status: 409, message: "The skill's folder is open in another program. Close it and try again." };

type Db = ReturnType<typeof createDb>;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

function skillMarkdown(name: string) {
  return `---\nname: ${name}\n---\n\n# ${name}\n`;
}

async function exists(target: string) {
  return fs.lstat(target).then(() => true, () => false);
}

describeEmbeddedPostgres("companySkillService.deleteSkill", () => {
  let db!: Db;
  let svc!: ReturnType<typeof companySkillService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const cleanupDirs = new Set<string>();
  const cleanupLinks = new Set<string>();
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;
  const originalPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-skills-delete-");
    db = createDb(tempDb.connectionString);
    svc = companySkillService(db);
  }, 90_000);

  // Skills made here are written under the instance folder, so each test gets its own.
  beforeEach(async () => {
    process.env.PAPERCLIP_HOME = await makeTempDir("paperclip-skill-delete-home-");
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
    if (originalPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalPaperclipInstanceId;

    await db.delete(companySkills);
    await db.delete(agents);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
    // Links go first, so removing a folder never reaches through one.
    for (const link of cleanupLinks) {
      await fs.unlink(link).catch(() => fs.rmdir(link).catch(() => undefined));
    }
    cleanupLinks.clear();
    await Promise.all(Array.from(cleanupDirs, (dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function makeTempDir(prefix: string) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    cleanupDirs.add(dir);
    return dir;
  }

  async function writeSkill(skillDir: string, name: string) {
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), skillMarkdown(name), "utf8");
  }

  async function createCompany(workspaceCwd: string | null = null) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    if (workspaceCwd) {
      const projectId = randomUUID();
      await db.insert(projects).values({ id: projectId, companyId, name: "Repo" });
      await db.insert(projectWorkspaces).values({ companyId, projectId, name: "Main", cwd: workspaceCwd, isPrimary: true });
    }
    return companyId;
  }

  async function createSkillWithExtraFile(companyId: string) {
    const skill = await svc.createLocalSkill(companyId, { name: "Code review" });
    const skillDir = skill.sourceLocator!;
    await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "references", "old.md"), "Old notes.\n", "utf8");
    return { skill, skillDir };
  }

  async function expectSkillKept(companyId: string, skillId: string, skillDir: string) {
    await expect(svc.getById(companyId, skillId)).resolves.toMatchObject({ id: skillId });
    await expect(fs.readFile(path.join(skillDir, "references", "old.md"), "utf8")).resolves.toBe("Old notes.\n");
  }

  // Holds a short name's lock, as a delete or a create that got there first
  // would, after doing some work in that transaction.
  async function holdShortNameLock(companyId: string, slug: string, work?: (tx: Transaction) => Promise<void>) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let markHeld!: () => void;
    const held = new Promise<void>((resolve) => { markHeld = resolve; });
    const finished = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${companyId}:${slug}`}, 0))`);
      await work?.(tx);
      markHeld();
      await released;
    });
    await Promise.race([held, finished]);
    return { release, finished };
  }

  async function waitUntilSomethingWaitsForALock() {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const [waiting] = await db.execute<{ count: number }>(sql`select count(*)::int as count from pg_locks where not granted`);
      if ((waiting?.count ?? 0) > 0) return;
      if (Date.now() > deadline) throw new Error("The delete never waited for the lock.");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it("removes the folder of a skill made here, so its short name can be used again without the old files", async () => {
    const companyId = await createCompany();
    const { skill, skillDir } = await createSkillWithExtraFile(companyId);

    await expect(svc.deleteSkill(companyId, skill.id)).resolves.toMatchObject({ id: skill.id });

    expect(await exists(skillDir)).toBe(false);
    await expect(svc.getById(companyId, skill.id)).resolves.toBeNull();
    // Nothing is left where the folder was moved aside before it was removed.
    const asideRoot = path.join(path.dirname(skillDir), ".deleted");
    expect(await fs.readdir(asideRoot).catch(() => [])).toEqual([]);

    const again = await svc.createLocalSkill(companyId, { name: "Code review" });
    expect(again.sourceLocator).toBe(skillDir);
    expect(await fs.readdir(skillDir)).toEqual(["SKILL.md"]);
  });

  it("keeps the folder of every skill it did not make", async () => {
    const workspace = await makeTempDir("paperclip-delete-workspace-");
    await writeSkill(path.join(workspace, "skills", "scanned"), "Scanned");
    const companyId = await createCompany(workspace);
    const importedDir = path.join(await makeTempDir("paperclip-delete-import-"), "imported");
    await writeSkill(importedDir, "Imported");
    await fs.writeFile(path.join(importedDir, "notes.md"), "Notes.\n", "utf8");

    const { imported: [imported] } = await svc.importFromSource(companyId, importedDir);
    const { imported: [scanned] } = await svc.scanProjectWorkspaces(companyId);
    // A bundled skill's folder is part of Paperclip itself.
    const bundled = (await svc.listFull(companyId)).find((skill) => skill.metadata?.sourceKind === "paperclip_bundled");
    expect(bundled?.sourceLocator).toBeTruthy();

    for (const skill of [imported!, scanned!, bundled!]) {
      await expect(svc.deleteSkill(companyId, skill.id), skill.slug).resolves.toMatchObject({ id: skill.id });
      expect(await exists(path.join(skill.sourceLocator!, "SKILL.md")), skill.slug).toBe(true);
    }
    await expect(fs.readFile(path.join(importedDir, "notes.md"), "utf8")).resolves.toBe("Notes.\n");
  });

  it.each([
    ["the same company", false],
    ["another company", true],
  ])("keeps a folder that a skill in %s was imported from", async (_label, inAnotherCompany) => {
    const companyId = await createCompany();
    const { skill, skillDir } = await createSkillWithExtraFile(companyId);
    const importerId = inAnotherCompany ? await createCompany() : companyId;
    const { imported: [copy] } = await svc.importFromSource(importerId, skillDir);
    expect(copy?.id).toBeTruthy();
    expect(copy?.id).not.toBe(skill.id);

    await svc.deleteSkill(companyId, skill.id);

    await expect(svc.getById(companyId, skill.id)).resolves.toBeNull();
    await expect(fs.readFile(path.join(skillDir, "references", "old.md"), "utf8")).resolves.toBe("Old notes.\n");
    await expect(svc.readFile(importerId, copy!.id, "SKILL.md")).resolves.toMatchObject({ path: "SKILL.md" });

    // Deleting the imported skill keeps the folder too.
    await expect(svc.deleteSkill(importerId, copy!.id)).resolves.toMatchObject({ id: copy!.id });
    await expect(fs.readFile(path.join(skillDir, "references", "old.md"), "utf8")).resolves.toBe("Old notes.\n");
  });

  it("never removes anything outside the company's skills folder", async () => {
    const companyId = await createCompany();
    const outside = await makeTempDir("paperclip-delete-outside-");
    await writeSkill(outside, "Outside");

    // A skill whose folder was swapped for a link that leads out.
    const { skill: linked, skillDir: linkedDir } = await createSkillWithExtraFile(companyId);
    await fs.rm(linkedDir, { recursive: true, force: true });
    await fs.symlink(outside, linkedDir, "junction");
    cleanupLinks.add(linkedDir);
    // A skill saved as made here, but whose folder is somewhere else.
    const storedId = randomUUID();
    await db.insert(companySkills).values({
      id: storedId,
      companyId,
      key: `company/${companyId}/stored`,
      slug: "stored",
      name: "Stored",
      markdown: skillMarkdown("Stored"),
      sourceType: "local_path",
      sourceLocator: outside,
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      metadata: { sourceKind: "managed_local" },
    });

    await expect(svc.deleteSkill(companyId, linked.id)).resolves.toMatchObject({ id: linked.id });
    await expect(svc.deleteSkill(companyId, storedId)).resolves.toMatchObject({ id: storedId });

    await expect(fs.readFile(path.join(outside, "SKILL.md"), "utf8")).resolves.toBe(skillMarkdown("Outside"));
  });

  it("puts the folder back when the delete cannot be saved", async () => {
    const companyId = await createCompany();
    const { skill, skillDir } = await createSkillWithExtraFile(companyId);
    await db.execute(sql`
      create function refuse_skill_delete() returns trigger language plpgsql as $$
      begin
        raise exception 'skill deletes are refused in this test';
      end
      $$
    `);
    await db.execute(sql`
      create trigger refuse_skill_delete before delete on company_skills
      for each row execute function refuse_skill_delete()
    `);

    try {
      await expect(svc.deleteSkill(companyId, skill.id)).rejects.toThrow();
    } finally {
      await db.execute(sql`drop trigger refuse_skill_delete on company_skills`);
      await db.execute(sql`drop function refuse_skill_delete()`);
    }

    await expectSkillKept(companyId, skill.id, skillDir);
  });

  it("keeps a folder another company's skill was imported from through a link", async () => {
    const companyId = await createCompany();
    const { skill, skillDir } = await createSkillWithExtraFile(companyId);
    const otherCompanyId = await createCompany();
    const linkPath = path.join(await makeTempDir("paperclip-delete-link-"), "shared-review");
    await fs.symlink(skillDir, linkPath, "junction");
    cleanupLinks.add(linkPath);
    const { imported: [copy] } = await svc.importFromSource(otherCompanyId, linkPath);
    expect(copy?.sourceLocator).toBe(linkPath);

    await svc.deleteSkill(companyId, skill.id);

    await expect(fs.readFile(path.join(skillDir, "references", "old.md"), "utf8")).resolves.toBe("Old notes.\n");
    // The other company's next skills list still has its skill.
    expect((await svc.listFull(otherCompanyId)).map((entry) => entry.id)).toContain(copy!.id);
  });

  it.runIf(process.platform === "win32")("refuses with a 409 while a program is working in the folder, and loses nothing", async () => {
    const companyId = await createCompany();
    const { skill, skillDir } = await createSkillWithExtraFile(companyId);
    const program = spawn(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"], {
      cwd: skillDir,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const exited = new Promise((resolve) => program.once("exit", resolve));
    try {
      await new Promise((resolve) => program.stdout!.once("data", resolve));
      await expect(svc.deleteSkill(companyId, skill.id)).rejects.toMatchObject(FOLDER_OPEN);
    } finally {
      program.kill();
      await exited;
    }

    await expectSkillKept(companyId, skill.id, skillDir);
    // Once the program is closed, the delete goes through.
    await expect(svc.deleteSkill(companyId, skill.id)).resolves.toMatchObject({ id: skill.id });
    expect(await exists(skillDir)).toBe(false);
  });

  it.each(["EBUSY", "EPERM", "EACCES"])("answers %s on moving the folder with a 409 and loses nothing", async (code) => {
    const companyId = await createCompany();
    const { skill, skillDir } = await createSkillWithExtraFile(companyId);
    vi.spyOn(fs, "rename").mockRejectedValueOnce(Object.assign(new Error(`${code}: the folder is in use`), { code }));

    await expect(svc.deleteSkill(companyId, skill.id)).rejects.toMatchObject(FOLDER_OPEN);

    await expectSkillKept(companyId, skill.id, skillDir);
  });

  it("removes folders earlier deletes left aside once their skill is gone", async () => {
    const companyId = await createCompany();
    const { skill: kept } = await createSkillWithExtraFile(companyId);
    const other = await svc.createLocalSkill(companyId, { name: "Other" });
    const asideRoot = path.join(path.dirname(other.sourceLocator!), ".deleted");
    // Left by a delete that was saved but stopped before removing the folder.
    const leftover = path.join(asideRoot, `${randomUUID()}-${randomUUID()}`);
    // Moved by a delete of a skill that still exists, which may still be running.
    const stillRunning = path.join(asideRoot, `${kept.id}-${randomUUID()}`);
    // Not put there by a delete.
    const unrelated = path.join(asideRoot, "notes");
    for (const folder of [leftover, stillRunning, unrelated]) await writeSkill(folder, "Aside");

    await expect(svc.deleteSkill(companyId, other.id)).resolves.toMatchObject({ id: other.id });

    expect(await exists(leftover)).toBe(false);
    expect(await exists(stillRunning)).toBe(true);
    expect(await exists(unrelated)).toBe(true);
  });

  it("refuses the delete when an agent is given the skill while the delete waits", async () => {
    const companyId = await createCompany();
    const { skill, skillDir } = await createSkillWithExtraFile(companyId);
    const lock = await holdShortNameLock(companyId, "code-review");

    const pendingDelete = svc.deleteSkill(companyId, skill.id).catch((error: unknown) => error);
    await waitUntilSomethingWaitsForALock();
    await db.insert(agents).values({
      companyId,
      name: "Reviewer",
      adapterConfig: { paperclipSkillSync: { desiredSkills: [skill.key] } },
    });
    lock.release();
    await lock.finished;

    expect(await pendingDelete).toMatchObject({
      status: 422,
      message: expect.stringContaining("still used by Reviewer"),
    });
    await expectSkillKept(companyId, skill.id, skillDir);
  });

  it("leaves a skill made again with the short name alone when an earlier delete finishes late", async () => {
    const companyId = await createCompany();
    const { skill, skillDir } = await createSkillWithExtraFile(companyId);
    const newMarkdown = skillMarkdown("Code review, made again");

    // The skill is deleted and made again while the lock is held.
    const lock = await holdShortNameLock(companyId, "code-review", async (tx) => {
      await tx.delete(companySkills).where(eq(companySkills.id, skill.id));
      await fs.rm(skillDir, { recursive: true, force: true });
      await writeSkill(skillDir, "Code review, made again");
      await tx.insert(companySkills).values({
        companyId,
        key: `company/${companyId}/code-review`,
        slug: "code-review",
        name: "Code review",
        markdown: newMarkdown,
        sourceType: "local_path",
        sourceLocator: skillDir,
        fileInventory: [{ path: "SKILL.md", kind: "skill" }],
        metadata: { sourceKind: "managed_local" },
      });
    });

    // This delete read the old skill before it was replaced.
    const lateDelete = svc.deleteSkill(companyId, skill.id);
    await waitUntilSomethingWaitsForALock();
    lock.release();
    await lock.finished;

    await expect(lateDelete).resolves.toBeNull();
    await expect(fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).resolves.toBe(newMarkdown);
    await expect(svc.getByKey(companyId, `company/${companyId}/code-review`)).resolves.toMatchObject({ markdown: newMarkdown });
  });
});
