import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  companySkills,
  createDb,
  skillTemplates,
  templateDeployments,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companySkillService } from "../services/company-skills.js";
import { templateService } from "../services/templates.js";
import { companySkillRoutes } from "../routes/company-skills.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company skill create tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("companySkillService.createLocalSkill", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof companySkillService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const cleanupDirs = new Set<string>();
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;
  const originalPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-skills-create-");
    db = createDb(tempDb.connectionString);
    svc = companySkillService(db);
  }, 90_000);

  // New skills are written under the instance folder, so each test gets its own.
  beforeEach(async () => {
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skill-create-home-"));
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
  });

  afterEach(async () => {
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
    if (originalPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalPaperclipInstanceId;

    await db.delete(activityLog);
    await db.delete(templateDeployments);
    await db.delete(skillTemplates);
    await db.delete(companySkills);
    await db.delete(companies);
    await Promise.all(Array.from(cleanupDirs, (dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("refuses a slug that is taken and leaves that skill as it was", async () => {
    const companyId = await createCompany();
    const original = await svc.createLocalSkill(companyId, {
      name: "Code review",
      markdown: "---\nname: Code review\n---\n\n# Code review\n\nThe original text.\n",
    });
    // The existing skill has more files than SKILL.md.
    const skillDir = original.sourceLocator!;
    await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "references", "checklist.md"), "- Tests pass\n", "utf8");
    await db
      .update(companySkills)
      .set({
        fileInventory: [
          { path: "references/checklist.md", kind: "reference" },
          { path: "SKILL.md", kind: "skill" },
        ],
      })
      .where(eq(companySkills.id, original.id));

    await expect(svc.createLocalSkill(companyId, {
      name: "Code review",
      markdown: "---\nname: Code review\n---\n\n# Code review\n\nA replacement.\n",
    })).rejects.toMatchObject({
      status: 409,
      message: 'A company skill with slug "code-review" already exists.',
    });
    await expect(svc.createLocalSkill(companyId, { name: "Second review", slug: "code-review" }))
      .rejects.toMatchObject({ status: 409 });

    await expect(fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).resolves.toContain("The original text.");
    const kept = await svc.getById(companyId, original.id);
    expect(kept).toMatchObject({
      name: "Code review",
      markdown: expect.stringContaining("The original text."),
    });
    expect(kept?.fileInventory.map((entry) => entry.path)).toEqual(["references/checklist.md", "SKILL.md"]);

    await expect(svc.createLocalSkill(companyId, { name: "Code review", slug: "code-review-2" }))
      .resolves.toMatchObject({ slug: "code-review-2" });
  });

  it("lets only one of several creates at once have the slug", async () => {
    const companyId = await createCompany();
    // Open several database connections first, so the creates below run side
    // by side instead of each waiting for a new connection.
    await Promise.all(Array.from({ length: 4 }, () => db.execute(sql`select pg_sleep(0.2)`)));

    const results = await Promise.allSettled(["First", "Second", "Third"].map((text) => svc.createLocalSkill(companyId, {
      name: "Code review",
      markdown: `---\nname: Code review\n---\n\n# Code review\n\n${text} text.\n`,
    })));

    const created = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    const refused = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    expect(created).toHaveLength(1);
    expect(refused).toEqual([
      expect.objectContaining({ status: 409, message: 'A company skill with slug "code-review" already exists.' }),
      expect.objectContaining({ status: 409, message: 'A company skill with slug "code-review" already exists.' }),
    ]);
    // The file and the saved skill both hold the text of the create that won.
    const winner = created[0]!;
    await expect(fs.readFile(path.join(winner.sourceLocator!, "SKILL.md"), "utf8")).resolves.toBe(winner.markdown);
    expect((await svc.getById(companyId, winner.id))?.markdown).toBe(winner.markdown);
  });

  it("refuses a slug whose folder a deleted skill left behind", async () => {
    const companyId = await createCompany();
    const deleted = await svc.createLocalSkill(companyId, { name: "Code review" });
    const skillDir = deleted.sourceLocator!;
    await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "references", "old.md"), "Old notes.\n", "utf8");
    await svc.deleteSkill(companyId, deleted.id);

    await expect(svc.createLocalSkill(companyId, { name: "Code review" })).rejects.toMatchObject({
      status: 409,
      message: 'A skill folder named "code-review" already exists. Choose another slug.',
    });
    await expect(svc.getByKey(companyId, `company/${companyId}/code-review`)).resolves.toBeNull();
    await expect(fs.readFile(path.join(skillDir, "references", "old.md"), "utf8")).resolves.toBe("Old notes.\n");
  });

  it("refuses a slug whose folder another skill was imported from", async () => {
    const companyId = await createCompany();
    const other = await svc.createLocalSkill(companyId, { name: "Other" });
    const skillDir = path.join(path.dirname(other.sourceLocator!), "code-review");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "---\nname: Code review\n---\n\n# Imported text\n", "utf8");
    const { imported: [importedSkill] } = await svc.importFromSource(companyId, skillDir);
    expect(importedSkill?.key).not.toBe(`company/${companyId}/code-review`);

    await expect(svc.createLocalSkill(companyId, { name: "Code review" })).rejects.toMatchObject({
      status: 409,
      message: 'A skill folder named "code-review" already exists. Choose another slug.',
    });
    await expect(fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).resolves.toContain("# Imported text");
  });

  it("leaves no folder behind when a create fails", async () => {
    const companyId = await createCompany();
    const other = await svc.createLocalSkill(companyId, { name: "Other" });
    const managedRoot = path.dirname(path.dirname(other.sourceLocator!));
    // No such company, so saving the skill fails after its folder is made.
    const missingCompanyId = randomUUID();

    await expect(svc.createLocalSkill(missingCompanyId, { name: "Code review" })).rejects.toThrow();
    await expect(fs.stat(path.join(managedRoot, missingCompanyId, "code-review"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("answers 409 with the message the create forms show", async () => {
    const companyId = await createCompany();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "local-board",
        companyIds: [companyId],
        source: "local_implicit",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", companySkillRoutes(db));
    app.use(errorHandler);

    const first = await request(app).post(`/api/companies/${companyId}/skills`).send({ name: "Code review" });
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    const second = await request(app).post(`/api/companies/${companyId}/skills`).send({ name: "Code review" });
    expect(second.status, JSON.stringify(second.body)).toBe(409);
    expect(second.body).toEqual({ error: 'A company skill with slug "code-review" already exists.' });
  });

  it("deploys a skill template without replacing a skill that only shares its slug", async () => {
    const companyId = await createCompany();
    const own = await svc.createLocalSkill(companyId, {
      name: "Code review",
      markdown: "---\nname: Code review\n---\n\n# Code review\n\nOur own text.\n",
    });
    const templates = templateService(db);
    const template = await templates.createSkillTemplate({
      name: "Code review template",
      skillKey: "code-review",
      skillName: "Code review",
      markdown: "---\nname: Code review\n---\n\n# Code review\n\nTemplate text.\n",
    }, { userId: null });

    const result = await templates.deploy("skill", template.id, { companyIds: [companyId], skipExisting: true }, {
      userId: null,
    });

    expect(result.results).toEqual([
      expect.objectContaining({
        status: "error",
        message: 'A company skill with slug "code-review" already exists.',
      }),
    ]);
    expect((await svc.getById(companyId, own.id))?.markdown).toContain("Our own text.");
  });

  it("redeploys a skill template over the skill it deployed before", async () => {
    const companyId = await createCompany();
    const templates = templateService(db);
    const template = await templates.createSkillTemplate({
      name: "Code review template",
      skillKey: "code-review",
      skillName: "Code review",
      markdown: "---\nname: Code review\n---\n\n# Code review\n\nFirst version.\n",
    }, { userId: null });

    const first = await templates.deploy("skill", template.id, { companyIds: [companyId], skipExisting: true }, {
      userId: null,
    });
    expect(first.results).toEqual([expect.objectContaining({ status: "created" })]);
    const deployedSkillId = first.results[0]!.deployedEntityId!;

    await templates.updateSkillTemplate(template.id, {
      markdown: "---\nname: Code review\n---\n\n# Code review\n\nSecond version.\n",
    }, { userId: null });
    const second = await templates.deploy("skill", template.id, { companyIds: [companyId], skipExisting: false }, {
      userId: null,
    });

    expect(second.results).toEqual([
      expect.objectContaining({ status: "created", deployedEntityId: deployedSkillId }),
    ]);
    expect((await svc.getById(companyId, deployedSkillId))?.markdown).toContain("Second version.");
  });
});
