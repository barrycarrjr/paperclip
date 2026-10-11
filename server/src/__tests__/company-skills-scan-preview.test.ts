import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import express from "express";
import request from "supertest";
import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
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
import { companySkillRoutes } from "../routes/company-skills.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres project scan preview tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function skillMarkdown(name: string, description = name) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

describeEmbeddedPostgres("project scan preview", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof companySkillService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let paperclipHome = "";
  let previousHome: string | undefined;
  const cleanupDirs = new Set<string>();
  const cleanupLinks = new Set<string>();

  beforeAll(async () => {
    // Skills made here are written under the instance folder.
    previousHome = process.env.PAPERCLIP_HOME;
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-scan-preview-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-scan-preview-");
    db = createDb(tempDb.connectionString);
    svc = companySkillService(db);
  }, 90_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(companySkills);
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

  async function writeSkill(skillDir: string, name: string, description = name) {
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), skillMarkdown(name, description), "utf8");
  }

  async function seedCompany(workspaceCwd: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Scan Co",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Repo" });
    const [workspace] = await db
      .insert(projectWorkspaces)
      .values({ companyId, projectId, name: "Main", cwd: workspaceCwd, isPrimary: true })
      .returning();
    return { companyId, projectId, workspaceId: workspace!.id };
  }

  // The company's own skills, without the bundled ones every refresh rewrites.
  async function ownSkillRows(companyId: string) {
    const rows = await db
      .select()
      .from(companySkills)
      .where(eq(companySkills.companyId, companyId))
      .orderBy(asc(companySkills.key));
    return rows.filter((row) => row.metadata?.sourceKind !== "paperclip_bundled");
  }

  it("lists what an import would do and saves nothing, and the import then does what it listed", async () => {
    const workspace = await makeTempDir("paperclip-scan-preview-workspace-");
    await writeSkill(path.join(workspace, "skills", "kept"), "Kept");
    const { companyId, projectId, workspaceId } = await seedCompany(workspace);
    // Imported by an earlier scan, and changed on disk since.
    await svc.scanProjectWorkspaces(companyId);
    await writeSkill(path.join(workspace, "skills", "kept"), "Kept", "Changed since the last scan");
    await writeSkill(path.join(workspace, "skills", "fresh"), "Fresh");
    // The short name is taken by a skill made here.
    await svc.createLocalSkill(companyId, { name: "Taken" });
    await writeSkill(path.join(workspace, "skills", "taken"), "Taken");
    // A linked scan folder pulls this one in from outside the workspace.
    const outsideSkills = await makeTempDir("paperclip-scan-preview-outside-");
    await writeSkill(path.join(outsideSkills, "escaped"), "Escaped");
    await fs.mkdir(path.join(workspace, ".agents"), { recursive: true });
    await fs.symlink(outsideSkills, path.join(workspace, ".agents", "skills"), "junction");
    cleanupLinks.add(path.join(workspace, ".agents", "skills"));
    const rowsBefore = await ownSkillRows(companyId);

    const preview = await svc.scanProjectWorkspaces(companyId, { mode: "preview" });

    expect(preview.imported).toEqual([]);
    expect(preview.updated).toEqual([]);
    expect(await ownSkillRows(companyId)).toEqual(rowsBefore);
    const place = { projectId, projectName: "Repo", workspaceId, workspaceName: "Main" };
    const byPath = new Map(preview.candidates?.map((candidate) => [candidate.relativePath, candidate]));
    expect(Array.from(byPath.keys()).sort()).toEqual([
      ".agents/skills/escaped",
      "skills/fresh",
      "skills/kept",
      "skills/taken",
    ]);
    expect(byPath.get("skills/fresh")).toEqual({
      ...place,
      slug: "fresh",
      name: "Fresh",
      description: "Fresh",
      directoryRoot: "skills",
      relativePath: "skills/fresh",
      status: "new",
    });
    expect(byPath.get("skills/kept")).toMatchObject({
      status: "already_imported",
      existingSkillId: rowsBefore.find((row) => row.slug === "kept")?.id,
    });
    expect(byPath.get("skills/taken")).toMatchObject({
      status: "conflict",
      reason: expect.stringContaining("Slug taken is already in use"),
    });
    expect(byPath.get(".agents/skills/escaped")).toMatchObject({
      directoryRoot: ".agents/skills",
      status: "skipped",
      reason: expect.stringContaining("outside the project workspace"),
    });
    expect(preview.conflicts.map((entry) => entry.slug)).toEqual(["taken"]);
    expect(preview.skipped.map((entry) => entry.path)).toEqual([path.join(workspace, ".agents", "skills", "escaped")]);

    const result = await svc.scanProjectWorkspaces(companyId);

    expect(result.imported.map((skill) => skill.slug)).toEqual(["fresh"]);
    expect(result.updated).toEqual([
      expect.objectContaining({ slug: "kept", description: "Changed since the last scan" }),
    ]);
    expect(result.candidates?.map((candidate) => [candidate.relativePath, candidate.status]))
      .toEqual(preview.candidates?.map((candidate) => [candidate.relativePath, candidate.status]));
  });

  it("agrees with the import when two workspaces hold a skill with the same short name", async () => {
    const firstWorkspace = await makeTempDir("paperclip-scan-preview-workspace-");
    const secondWorkspace = await makeTempDir("paperclip-scan-preview-workspace-");
    await writeSkill(path.join(firstWorkspace, "skills", "dup"), "Dup");
    await writeSkill(path.join(secondWorkspace, "skills", "dup"), "Dup");
    const { companyId, projectId, workspaceId } = await seedCompany(firstWorkspace);
    const [second] = await db
      .insert(projectWorkspaces)
      .values({ companyId, projectId, name: "Second", cwd: secondWorkspace, isPrimary: false })
      .returning();
    const outcomes = (result: Awaited<ReturnType<typeof svc.scanProjectWorkspaces>>) =>
      result.candidates?.map((candidate) => [candidate.workspaceId, candidate.relativePath, candidate.status]);

    const preview = await svc.scanProjectWorkspaces(companyId, { mode: "preview" });

    expect(outcomes(preview)).toEqual([
      [workspaceId, "skills/dup", "new"],
      [second!.id, "skills/dup", "conflict"],
    ]);
    expect(preview.conflicts.map((entry) => entry.path)).toEqual([path.join(secondWorkspace, "skills", "dup")]);
    expect(await ownSkillRows(companyId)).toEqual([]);

    const result = await svc.scanProjectWorkspaces(companyId);

    expect(outcomes(result)).toEqual(outcomes(preview));
    expect(result.imported.map((skill) => skill.sourceLocator)).toEqual([path.join(firstWorkspace, "skills", "dup")]);
  });

  it("refuses a selection instead of importing every skill it finds", async () => {
    const workspace = await makeTempDir("paperclip-scan-preview-workspace-");
    await writeSkill(path.join(workspace, "skills", "wanted"), "Wanted");
    await writeSkill(path.join(workspace, "skills", "unwanted"), "Unwanted");
    const { companyId, workspaceId } = await seedCompany(workspace);

    await expect(svc.scanProjectWorkspaces(companyId, {
      selection: [{ workspaceId, path: "skills/wanted" }],
    })).rejects.toMatchObject({
      status: 422,
      message: "Choosing which skills to import is not supported. Scan without a selection.",
    });
    expect(await ownSkillRows(companyId)).toEqual([]);
  });

  it("answers a preview through the route and logs it as a preview", async () => {
    const workspace = await makeTempDir("paperclip-scan-preview-workspace-");
    await writeSkill(path.join(workspace, "skills", "fresh"), "Fresh");
    const { companyId } = await seedCompany(workspace);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "admin-user",
        companyIds: [companyId],
        source: "session",
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api", companySkillRoutes(db));
    app.use(errorHandler);

    const res = await request(app).post(`/api/companies/${companyId}/skills/scan-projects`).send({ mode: "preview" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.imported).toEqual([]);
    expect(res.body.candidates).toEqual([expect.objectContaining({ slug: "fresh", status: "new" })]);
    expect(await ownSkillRows(companyId)).toEqual([]);
    const [entry] = await db.select().from(activityLog).where(eq(activityLog.action, "company.skills_scanned"));
    expect(entry?.details).toMatchObject({ mode: "preview", discovered: 1, importedCount: 0 });
  });
});
