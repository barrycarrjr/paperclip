import { randomUUID } from "node:crypto";
import { promises as fs, type PathLike } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  companySkills,
  createDb,
  principalPermissionGrants,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companySkillService } from "../services/company-skills.js";
import { companySkillRoutes } from "../routes/company-skills.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres skill folder boundary tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// A file symlink needs Developer Mode or admin rights on Windows.
async function canCreateFileLinks() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-link-probe-"));
  try {
    await fs.writeFile(path.join(dir, "target.txt"), "", "utf8");
    await fs.symlink(path.join(dir, "target.txt"), path.join(dir, "link.txt"), "file");
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const fileLinksSupported = await canCreateFileLinks();

const SECRET = "TOP SECRET: this file is not a skill";
const ADMIN_REQUIRED = { status: 403, code: "skill_local_import_admin_required" };
const PATH_NOT_SUPPORTED = { status: 422, details: { code: "skill_source_path_not_supported" } };
const FILE_DENIED = { status: 403, details: { code: "skill_file_boundary_denied" } };
const onWindows = process.platform === "win32";

function skillMarkdown(name: string) {
  return `---\nname: ${name}\ndescription: ${name}\n---\n\n# ${name}\n`;
}

async function exists(target: string) {
  return fs.lstat(target).then(() => true, () => false);
}

describeEmbeddedPostgres("company skill folder boundaries", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof companySkillService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let paperclipHome = "";
  let previousHome: string | undefined;
  const cleanupDirs = new Set<string>();
  const cleanupLinks = new Set<string>();

  beforeAll(async () => {
    // Managed skills, runtime copies and catalog copies all live under the
    // instance root, so point it at a temporary folder.
    previousHome = process.env.PAPERCLIP_HOME;
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skill-boundary-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-skill-boundary-");
    db = createDb(tempDb.connectionString);
    svc = companySkillService(db);
  }, 90_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await db.delete(activityLog);
    await db.delete(companySkills);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
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
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    await fs.rm(paperclipHome, { recursive: true, force: true });
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

  // A junction needs no special rights on Windows. Other systems ignore the
  // type and make an ordinary directory symlink.
  async function linkDir(target: string, linkPath: string) {
    await fs.symlink(target, linkPath, "junction");
    cleanupLinks.add(linkPath);
  }

  async function seedCompany(workspaceCwd: string | null) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Boundary Co",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    if (workspaceCwd) {
      const projectId = randomUUID();
      await db.insert(projects).values({ id: projectId, companyId, name: "Approved project" });
      await db.insert(projectWorkspaces).values({
        companyId,
        projectId,
        name: "Primary",
        cwd: workspaceCwd,
        isPrimary: true,
      });
    }
    return companyId;
  }

  // The folder outside every workspace, with a file that must never be read
  // or returned.
  async function makeOutside() {
    const outside = await makeTempDir("paperclip-outside-skill-");
    await fs.writeFile(path.join(outside, "secret.txt"), SECRET, "utf8");
    await writeSkill(outside, "escaped");
    return outside;
  }

  async function insertLocalSkill(companyId: string, skillDir: string, inventory: string[]) {
    const id = randomUUID();
    await db.insert(companySkills).values({
      id,
      companyId,
      key: `local/${id}/stored-skill`,
      slug: "stored-skill",
      name: "Stored Skill",
      description: null,
      markdown: skillMarkdown("stored-skill"),
      sourceType: "local_path",
      sourceLocator: skillDir,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: inventory.map((entry) => ({ path: entry, kind: entry === "SKILL.md" ? "skill" : "other" })),
      metadata: { sourceKind: "local_path" },
    });
    return id;
  }

  async function companySkillRows(companyId: string) {
    return db.select().from(companySkills).where(eq(companySkills.companyId, companyId));
  }

  function spyOnDiskAccess() {
    return [
      vi.spyOn(fs, "stat"),
      vi.spyOn(fs, "lstat"),
      vi.spyOn(fs, "realpath"),
      vi.spyOn(fs, "readFile"),
      vi.spyOn(fs, "readdir"),
    ];
  }

  function callsMatching(spies: ReturnType<typeof spyOnDiskAccess>, pattern: RegExp) {
    return spies
      .flatMap((spy) => spy.mock.calls as unknown[][])
      .map(([target]) => String(target))
      .filter((target) => pattern.test(target));
  }

  function callsUnder(spies: ReturnType<typeof spyOnDiskAccess>, folders: string[]) {
    const roots = folders.map((folder) => path.resolve(folder).toLowerCase());
    return spies
      .flatMap((spy) => spy.mock.calls as unknown[][])
      .map(([target]) => path.resolve(String(target)))
      .filter((target) => roots.some((root) => target.toLowerCase().startsWith(root)));
  }

  function routeApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", companySkillRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function instanceAdmin(companyId: string) {
    return {
      type: "board",
      userId: "admin-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: true,
    };
  }

  // A member who may otherwise manage company skills: an active membership
  // and the agents:create grant.
  async function seedSkillManager(companyId: string) {
    const userId = `member-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "operator",
    });
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "user",
      principalId: userId,
      permissionKey: "agents:create",
    });
    return {
      type: "board",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "operator", status: "active" }],
      source: "session",
      isInstanceAdmin: false,
    };
  }

  // An agent that may otherwise manage company skills, because it can create
  // agents.
  async function seedSkillManagerAgent(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Skill Builder",
      permissions: { canCreateAgents: true },
    });
    return { type: "agent", agentId, companyId, source: "agent_key" };
  }

  describe("local path import", () => {
    it("lets an instance admin import from a folder outside every workspace and the managed folder", async () => {
      const workspace = await makeTempDir("paperclip-approved-workspace-");
      const companyId = await seedCompany(workspace);
      const skillDir = path.join(await makeTempDir("paperclip-extensions-"), "skills", "release-notes");
      await writeSkill(skillDir, "release-notes");

      const res = await request(routeApp(instanceAdmin(companyId)))
        .post(`/api/companies/${companyId}/skills/import`)
        .send({ source: skillDir });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.imported).toEqual([
        expect.objectContaining({ slug: "release-notes", sourceLocator: skillDir }),
      ]);
    });

    it.each([
      ["a member who can manage skills", seedSkillManager],
      ["an agent that can create agents", seedSkillManagerAgent],
    ])("refuses %s a local import and a project scan before reading anything", async (_label, seedActor) => {
      const workspace = await makeTempDir("paperclip-approved-workspace-");
      await writeSkill(path.join(workspace, "skills", "in-workspace"), "in-workspace");
      const outside = await makeOutside();
      const companyId = await seedCompany(workspace);
      const app = routeApp(await seedActor(companyId));
      const spies = spyOnDiskAccess();

      for (const source of [path.join(outside, "secret.txt"), outside, path.join(workspace, "skills")]) {
        const res = await request(app).post(`/api/companies/${companyId}/skills/import`).send({ source });
        expect(res.status, JSON.stringify(res.body)).toBe(ADMIN_REQUIRED.status);
        expect(res.body.code).toBe(ADMIN_REQUIRED.code);
        expect(JSON.stringify(res.body)).not.toContain(SECRET);
      }
      const scan = await request(app).post(`/api/companies/${companyId}/skills/scan-projects`).send({});
      expect(scan.status, JSON.stringify(scan.body)).toBe(ADMIN_REQUIRED.status);
      expect(scan.body.code).toBe(ADMIN_REQUIRED.code);

      expect(callsUnder(spies, [outside, workspace])).toEqual([]);
      expect(await companySkillRows(companyId)).toEqual([]);
    });

    it("refuses UNC and device paths before anything touches the disk", async () => {
      const outside = await makeOutside();
      const companyId = await seedCompany(null);
      const spies = spyOnDiskAccess();

      for (const source of [
        "\\\\127.0.0.1\\paperclip-no-such-share\\skills",
        "//127.0.0.1/paperclip-no-such-share/skills",
        `\\\\?\\${outside}`,
        `\\\\.\\${outside}`,
      ]) {
        await expect(svc.importFromSource(companyId, source), source).rejects.toMatchObject(PATH_NOT_SUPPORTED);
      }
      expect(callsMatching(spies, /^[\\/]{2}/)).toEqual([]);
    });

    it("reads through where the source really is, so re-pointing a link during the import changes nothing", async () => {
      const companyId = await seedCompany(null);
      const first = await makeTempDir("paperclip-link-first-");
      const second = await makeTempDir("paperclip-link-second-");
      await writeSkill(path.join(first, "alpha"), "alpha");
      await writeSkill(path.join(second, "beta"), "beta");
      const linked = path.join(await makeTempDir("paperclip-link-parent-"), "skills");
      await linkDir(first, linked);
      // Re-point the link at the other folder the moment the import has
      // looked up where it leads.
      const realpath = fs.realpath;
      let repointed = false;
      vi.spyOn(fs, "realpath").mockImplementation((async (target: PathLike, options?: unknown) => {
        const real = await (realpath as (target: PathLike, options?: unknown) => Promise<string>)(target, options);
        if (!repointed && path.resolve(String(target)) === linked) {
          repointed = true;
          await fs.unlink(linked).catch(() => fs.rmdir(linked));
          await fs.symlink(second, linked, "junction");
        }
        return real;
      }) as typeof fs.realpath);

      const result = await svc.importFromSource(companyId, linked);

      expect(repointed).toBe(true);
      expect(result.imported.map((skill) => skill.slug)).toEqual(["alpha"]);
      // The skill keeps the path it was imported by, which its key comes from.
      expect(result.imported[0]!.sourceLocator).toBe(path.join(linked, "alpha"));
    });

    it("refuses a skill folder that turns into a link out of the imported folder before it is read", async () => {
      const companyId = await seedCompany(null);
      const outside = await makeOutside();
      const source = await makeTempDir("paperclip-import-source-");
      await writeSkill(path.join(source, "alpha"), "alpha");
      const realSkillDir = path.join(await fs.realpath(source), "alpha");
      // Swap the skill folder for a link right after the import has listed
      // it, which is the moment a race would need.
      const readdir = fs.readdir;
      let swapped = false;
      vi.spyOn(fs, "readdir").mockImplementation((async (target: PathLike, options?: unknown) => {
        const entries = await (readdir as (target: PathLike, options?: unknown) => Promise<unknown>)(target, options);
        if (!swapped && path.resolve(String(target)) === realSkillDir) {
          swapped = true;
          await fs.rename(realSkillDir, `${realSkillDir}-moved`);
          await linkDir(outside, realSkillDir);
        }
        return entries;
      }) as typeof fs.readdir);

      await expect(svc.importFromSource(companyId, source)).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining("outside the folder being imported"),
      });
      expect(swapped).toBe(true);
      expect((await companySkillRows(companyId)).map((row) => row.slug)).not.toContain("escaped");
    });

    it.runIf(fileLinksSupported)("refuses a SKILL.md that links to a file outside its folder", async () => {
      const companyId = await seedCompany(null);
      const outside = await makeOutside();
      const skillDir = path.join(await makeTempDir("paperclip-import-source-"), "linked-file");
      await fs.mkdir(skillDir, { recursive: true });
      const skillFile = path.join(skillDir, "SKILL.md");
      await fs.symlink(path.join(outside, "secret.txt"), skillFile, "file");
      cleanupLinks.add(skillFile);

      await expect(svc.importFromSource(companyId, skillFile)).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining("outside its folder"),
      });
      expect((await companySkillRows(companyId)).some((row) => row.markdown.includes(SECRET))).toBe(false);
    });
  });

  describe("skill file paths", () => {
    it("still writes a file that is inside the skill folder", async () => {
      const workspace = await makeTempDir("paperclip-approved-workspace-");
      const skillDir = path.join(workspace, "skills", "notes-skill");
      await writeSkill(skillDir, "notes-skill");
      await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
      await fs.writeFile(path.join(skillDir, "references", "notes.md"), "# Notes\n", "utf8");
      const companyId = await seedCompany(workspace);
      // Imported through the parent folder, because a folder import of the
      // skill itself lists only SKILL.md (a separate, known gap).
      const [skill] = (await svc.importFromSource(companyId, path.dirname(skillDir))).imported;

      await expect(
        svc.updateFile(companyId, skill!.id, "references/notes.md", "# Updated notes\n"),
      ).resolves.toMatchObject({ path: "references/notes.md", content: "# Updated notes\n" });
      await expect(fs.readFile(path.join(skillDir, "references", "notes.md"), "utf8")).resolves.toBe("# Updated notes\n");
    });

    it("refuses .., drive letters and UNC paths in a file path", async () => {
      const outside = await makeOutside();
      const companyId = await seedCompany(null);
      const skill = await svc.createLocalSkill(companyId, { name: "Managed Writer", slug: "managed-writer" });
      const skillDir = skill.sourceLocator!;
      const windowsTarget = onWindows ? path.join(outside, "pwned.txt") : "C:\\paperclip-outside\\pwned.txt";

      const filePaths = [
        "../escaped.txt",
        "references/../../escaped.txt",
        windowsTarget,
        windowsTarget.replace(/\\/g, "/"),
        "C:pwned.txt",
        "\\\\127.0.0.1\\share\\pwned.txt",
        "//127.0.0.1/share/pwned.txt",
      ];
      const outcomes = [];
      for (const filePath of filePaths) {
        outcomes.push(await svc.updateFile(companyId, skill.id, filePath, "pwned").catch((error: unknown) => error));
      }

      expect(await exists(path.join(outside, "pwned.txt"))).toBe(false);
      expect(await fs.readdir(skillDir)).toEqual(["SKILL.md"]);
      outcomes.forEach((outcome, index) => expect(outcome, filePaths[index]).toMatchObject(FILE_DENIED));
    });

    it("refuses to write through a junction or symlink that points out of the skill folder", async () => {
      const workspace = await makeTempDir("paperclip-approved-workspace-");
      const outside = await makeOutside();
      const skillDir = path.join(workspace, "skills", "linked-skill");
      await writeSkill(skillDir, "linked-skill");
      const companyId = await seedCompany(workspace);
      const [skill] = (await svc.importFromSource(companyId, skillDir)).imported;
      await linkDir(outside, path.join(skillDir, "escape"));

      const direct = await svc.updateFile(companyId, skill!.id, "escape/pwned.txt", "pwned")
        .catch((error: unknown) => error);
      const nested = await svc.updateFile(companyId, skill!.id, "escape/nested/pwned.txt", "pwned")
        .catch((error: unknown) => error);

      expect(await exists(path.join(outside, "pwned.txt"))).toBe(false);
      expect(await exists(path.join(outside, "nested"))).toBe(false);
      expect(direct).toMatchObject(FILE_DENIED);
      expect(nested).toMatchObject(FILE_DENIED);
    });

    it("refuses to read a stored file path that leads out of the skill folder", async () => {
      const workspace = await makeTempDir("paperclip-approved-workspace-");
      const outside = await makeOutside();
      const skillDir = path.join(workspace, "skills", "stored-skill");
      await writeSkill(skillDir, "stored-skill");
      await linkDir(outside, path.join(skillDir, "escape"));
      const companyId = await seedCompany(workspace);
      const skillId = await insertLocalSkill(companyId, skillDir, ["SKILL.md", "escape/secret.txt"]);

      await expect(svc.readFile(companyId, skillId, "SKILL.md")).resolves.toMatchObject({ path: "SKILL.md" });
      await expect(svc.readFile(companyId, skillId, "escape/secret.txt")).rejects.toMatchObject(FILE_DENIED);
    });

    it("does not mistake a missing skill folder for a path that leaves it", async () => {
      const companyId = await seedCompany(null);
      const missingDir = path.join(await makeTempDir("paperclip-missing-catalog-"), "gone");
      const skillId = randomUUID();
      await db.insert(companySkills).values({
        id: skillId,
        companyId,
        key: `company/${companyId}/gone-skill`,
        slug: "gone-skill",
        name: "Gone Skill",
        description: null,
        markdown: skillMarkdown("gone-skill"),
        sourceType: "catalog",
        sourceLocator: missingDir,
        trustLevel: "markdown_only",
        compatibility: "compatible",
        fileInventory: [{ path: "SKILL.md", kind: "skill" }],
        metadata: { sourceKind: "catalog" },
      });

      await expect(svc.readFile(companyId, skillId, "SKILL.md")).rejects.toMatchObject({ code: "ENOENT" });
    });

    it.runIf(onWindows)("refuses to read a stored drive letter path", async () => {
      const outside = await makeOutside();
      const skillDir = await makeTempDir("paperclip-stored-skill-");
      await writeSkill(skillDir, "stored-skill");
      const companyId = await seedCompany(null);
      const storedPath = `${outside.replace(/\\/g, "/")}/secret.txt`;
      const skillId = await insertLocalSkill(companyId, skillDir, ["SKILL.md", storedPath]);

      await expect(svc.readFile(companyId, skillId, storedPath)).rejects.toMatchObject(FILE_DENIED);
    });

    it.runIf(onWindows)("keeps a company package's files inside the catalog folder", async () => {
      const outside = await makeOutside();
      const companyId = await seedCompany(null);
      const escapingKey = `skills/pkg/${outside.replace(/\\/g, "/")}/pwned-catalog.txt`;

      const result = await svc.importPackageFiles(companyId, {
        "skills/pkg/SKILL.md": skillMarkdown("pkg"),
        [escapingKey]: "pwned",
      });

      expect(result.map((entry) => entry.skill.slug)).toEqual(["pkg"]);
      expect(await exists(path.join(outside, "pwned-catalog.txt"))).toBe(false);
      const catalogDir = result[0]!.skill.sourceLocator!;
      await expect(fs.readFile(path.join(catalogDir, "SKILL.md"), "utf8")).resolves.toBe(skillMarkdown("pkg"));
    });

    it.runIf(onWindows)("keeps the runtime copy of a remote skill inside the runtime folder", async () => {
      const outside = await makeOutside();
      const companyId = await seedCompany(null);
      const ref = "0".repeat(40);
      await db.insert(companySkills).values({
        companyId,
        key: "acme/tools/remote-skill",
        slug: "remote-skill",
        name: "Remote Skill",
        description: null,
        markdown: skillMarkdown("remote-skill"),
        sourceType: "github",
        sourceLocator: "https://github.com/acme/tools",
        sourceRef: ref,
        trustLevel: "markdown_only",
        compatibility: "compatible",
        fileInventory: [
          { path: "SKILL.md", kind: "skill" },
          { path: `${outside.replace(/\\/g, "/")}/pwned-runtime.txt`, kind: "other" },
        ],
        metadata: { sourceKind: "github", owner: "acme", repo: "tools", ref, repoSkillDir: "skills/remote-skill" },
      });
      vi.stubGlobal("fetch", vi.fn(async () => new Response("pwned", { status: 200 })));

      const entries = await svc.listRuntimeSkillEntries(companyId);

      const remote = entries.find((entry) => entry.key === "acme/tools/remote-skill");
      expect(remote).toBeDefined();
      await expect(fs.readFile(path.join(remote!.source, "SKILL.md"), "utf8")).resolves.toBe("pwned");
      expect(await exists(path.join(outside, "pwned-runtime.txt"))).toBe(false);
    });
  });

  describe("project scans", () => {
    it("skips skills that a linked scan folder pulls in from outside the workspace", async () => {
      const workspace = await makeTempDir("paperclip-approved-workspace-");
      const outsideSkills = await makeTempDir("paperclip-outside-skills-");
      await writeSkill(path.join(outsideSkills, "evil"), "evil");
      await writeSkill(path.join(workspace, "skills", "good"), "good");
      await fs.mkdir(path.join(workspace, ".agents"), { recursive: true });
      await linkDir(outsideSkills, path.join(workspace, ".agents", "skills"));
      const companyId = await seedCompany(workspace);

      const result = await svc.scanProjectWorkspaces(companyId);

      expect(result.imported.map((skill) => skill.slug)).toEqual(["good"]);
      expect(result.skipped).toEqual([
        expect.objectContaining({
          path: path.join(workspace, ".agents", "skills", "evil"),
          reason: expect.stringContaining("outside the project workspace"),
        }),
      ]);
    });

    it("does not list files from a linked support folder of a workspace root skill", async () => {
      const workspace = await makeTempDir("paperclip-approved-workspace-");
      const outside = await makeOutside();
      await writeSkill(workspace, "root-skill");
      await fs.mkdir(path.join(workspace, "scripts"), { recursive: true });
      await fs.writeFile(path.join(workspace, "scripts", "run.sh"), "echo ok\n", "utf8");
      await linkDir(outside, path.join(workspace, "references"));
      const companyId = await seedCompany(workspace);

      const result = await svc.scanProjectWorkspaces(companyId);

      const rootSkill = result.imported.find((skill) => skill.slug === "root-skill");
      expect(rootSkill?.fileInventory.map((entry) => entry.path).sort()).toEqual(["SKILL.md", "scripts/run.sh"]);
    });
  });
});
