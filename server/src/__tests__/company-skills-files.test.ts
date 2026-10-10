import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companySkills, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companySkillService } from "../services/company-skills.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company skill file tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("companySkillService.updateFile", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof companySkillService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const cleanupDirs = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-skills-files-");
    db = createDb(tempDb.connectionString);
    svc = companySkillService(db);
  }, 90_000);

  afterEach(async () => {
    await db.delete(companySkills);
    await db.delete(companies);
    await Promise.all(Array.from(cleanupDirs, (dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createSkill(options: {
    files?: Record<string, string>;
    fileInventory?: Array<{ path: string; kind: string }>;
    projectRoot?: boolean;
  } = {}) {
    const companyId = randomUUID();
    const skillId = randomUUID();
    const skillDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skill-files-"));
    cleanupDirs.add(skillDir);
    const files = { "SKILL.md": "# Field Notes\n", ...options.files };
    for (const [relativePath, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(skillDir, relativePath)), { recursive: true });
      await fs.writeFile(path.join(skillDir, relativePath), content, "utf8");
    }

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: `company/${companyId}/field-notes`,
      slug: "field-notes",
      name: "Field Notes",
      description: null,
      markdown: "# Field Notes\n",
      sourceType: "local_path",
      sourceLocator: skillDir,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: options.fileInventory ?? [{ path: "SKILL.md", kind: "skill" }],
      metadata: options.projectRoot
        ? { sourceKind: "project_scan", workspaceCwd: skillDir }
        : { sourceKind: "local_path" },
    });

    return { companyId, skillId, skillDir };
  }

  async function listedPaths(companyId: string, skillId: string) {
    const skill = await svc.getById(companyId, skillId);
    return skill?.fileInventory.map((entry) => entry.path);
  }

  it("lists and returns a file or folder that was just added", async () => {
    const { companyId, skillId, skillDir } = await createSkill();

    await expect(svc.updateFile(companyId, skillId, "references/notes.md", "")).resolves.toMatchObject({
      path: "references/notes.md",
      content: "",
    });
    await expect(svc.updateFile(companyId, skillId, "examples/README.md", "# Examples\n")).resolves.toMatchObject({
      path: "examples/README.md",
      content: "# Examples\n",
    });
    await expect(svc.updateFile(companyId, skillId, "scripts/run.sh", "echo hi\n")).resolves.toMatchObject({
      path: "scripts/run.sh",
    });

    expect(await listedPaths(companyId, skillId)).toEqual([
      "examples/README.md",
      "references/notes.md",
      "scripts/run.sh",
      "SKILL.md",
    ]);
    expect((await svc.getById(companyId, skillId))?.trustLevel).toBe("scripts_executables");
    await expect(fs.readFile(path.join(skillDir, "references", "notes.md"), "utf8")).resolves.toBe("");
  });

  // Add file sends no text; Add folder sends <folder>/README.md with a heading.
  it.each([
    ["Add file", "references/existing.md", ""],
    ["Add folder", "examples/README.md", "# examples\n"],
  ])("keeps a file that was on disk but not listed when %s sends it", async (_label, filePath, content) => {
    const { companyId, skillId, skillDir } = await createSkill({
      files: { [filePath]: "Keep this text.\n" },
    });

    await expect(svc.updateFile(companyId, skillId, filePath, content)).resolves.toMatchObject({
      path: filePath,
      content: "Keep this text.\n",
    });
    await expect(fs.readFile(path.join(skillDir, filePath), "utf8")).resolves.toBe("Keep this text.\n");
    expect(await listedPaths(companyId, skillId)).toContain(filePath);
  });

  it("still saves empty text to a file that is already listed", async () => {
    const { companyId, skillId, skillDir } = await createSkill({
      files: { "references/notes.md": "Old notes.\n" },
      fileInventory: [
        { path: "references/notes.md", kind: "reference" },
        { path: "SKILL.md", kind: "skill" },
      ],
    });

    await expect(svc.updateFile(companyId, skillId, "references/notes.md", "")).resolves.toMatchObject({
      content: "",
    });
    await expect(fs.readFile(path.join(skillDir, "references", "notes.md"), "utf8")).resolves.toBe("");
  });

  it("lists only the skill's own folders for a skill at a project's root", async () => {
    const { companyId, skillId, skillDir } = await createSkill({
      files: { "README.md": "# The project\n", "src/index.ts": "export {};\n" },
      projectRoot: true,
    });

    await expect(svc.updateFile(companyId, skillId, "references/notes.md", "Notes.\n")).resolves.toMatchObject({
      path: "references/notes.md",
      content: "Notes.\n",
    });
    expect(await listedPaths(companyId, skillId)).toEqual(["references/notes.md", "SKILL.md"]);

    await expect(svc.updateFile(companyId, skillId, "notes.md", "Notes.\n")).rejects.toMatchObject({
      status: 422,
    });
    await expect(fs.stat(path.join(skillDir, "notes.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves hidden files and node_modules out of the rebuilt list", async () => {
    const { companyId, skillId } = await createSkill({
      files: {
        ".env": "TOKEN=secret\n",
        ".git/config": "[core]\n",
        ".github/workflows/ci.yml": "on: push\n",
        "references/.draft.md": "Draft.\n",
        "node_modules/left-pad/index.js": "module.exports = 1;\n",
        "references/guide.md": "# Guide\n",
      },
    });

    await svc.updateFile(companyId, skillId, "references/notes.md", "Notes.\n");

    expect(await listedPaths(companyId, skillId)).toEqual([
      "references/guide.md",
      "references/notes.md",
      "SKILL.md",
    ]);
    await expect(svc.readFile(companyId, skillId, ".env")).rejects.toMatchObject({ status: 404 });
  });

  it.each([".env", "references/.draft.md", ".github/workflows/ci.yml", "node_modules/left-pad/index.js"])(
    "refuses to write %s, which the file list leaves out",
    async (filePath) => {
      const { companyId, skillId, skillDir } = await createSkill();

      await expect(svc.updateFile(companyId, skillId, filePath, "x\n")).rejects.toMatchObject({
        status: 422,
        message: "File and folder names in a skill can't start with a dot or be node_modules.",
      });
      await expect(fs.stat(path.join(skillDir, filePath))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});

describeEmbeddedPostgres("companySkillService.importFromSource", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof companySkillService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const cleanupDirs = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-skills-import-");
    db = createDb(tempDb.connectionString);
    svc = companySkillService(db);
  }, 90_000);

  afterEach(async () => {
    await db.delete(companySkills);
    await db.delete(companies);
    await Promise.all(Array.from(cleanupDirs, (dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("leaves hidden files out of imported skills but still finds skills in hidden folders", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skill-import-"));
    cleanupDirs.add(root);
    const files: Record<string, string> = {
      "skills/alpha/SKILL.md": "---\nname: Alpha\n---\n\n# Alpha\n",
      "skills/alpha/.env": "TOKEN=secret\n",
      "skills/alpha/references/guide.md": "# Guide\n",
      ".agents/skills/beta/SKILL.md": "---\nname: Beta\n---\n\n# Beta\n",
      ".agents/skills/beta/.secrets/token.txt": "secret\n",
    };
    for (const [relativePath, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
      await fs.writeFile(path.join(root, relativePath), content, "utf8");
    }

    const { imported } = await svc.importFromSource(companyId, root);

    expect(Object.fromEntries(imported.map((skill) => [skill.slug, skill.fileInventory.map((entry) => entry.path)])))
      .toEqual({
        alpha: ["references/guide.md", "SKILL.md"],
        beta: ["SKILL.md"],
      });
  });
});
