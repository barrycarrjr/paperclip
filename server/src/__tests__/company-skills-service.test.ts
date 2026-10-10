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
import { companySkillService } from "../services/company-skills.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company skill service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("companySkillService.list", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof companySkillService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const cleanupDirs = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-skills-service-");
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

  it("lists skills without exposing markdown content", async () => {
    const companyId = randomUUID();
    const skillId = randomUUID();
    const skillDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-heavy-skill-"));
    cleanupDirs.add(skillDir);
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Heavy Skill\n", "utf8");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: `company/${companyId}/heavy-skill`,
      slug: "heavy-skill",
      name: "Heavy Skill",
      description: "Large skill used for list projection regression coverage.",
      markdown: `# Heavy Skill\n\n${"x".repeat(250_000)}`,
      sourceType: "local_path",
      sourceLocator: skillDir,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      metadata: { sourceKind: "local_path" },
    });

    const listed = await svc.list(companyId);
    const skill = listed.find((entry) => entry.id === skillId);

    expect(skill).toBeDefined();
    expect(skill).not.toHaveProperty("markdown");
    expect(skill).toMatchObject({
      id: skillId,
      key: `company/${companyId}/heavy-skill`,
      slug: "heavy-skill",
      name: "Heavy Skill",
      sourceType: "local_path",
      sourceLocator: skillDir,
      attachedAgentCount: 0,
      sourceBadge: "local",
      editable: true,
    });
  });

  it("rejects skill inventory refresh for a missing company", async () => {
    await expect(svc.list(randomUUID())).rejects.toMatchObject({
      status: 404,
      message: "Company not found",
    });
  });

  it("resolves skill entries the same as plain keys", async () => {
    const companyId = randomUUID();
    const skillDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-review-skill-"));
    cleanupDirs.add(skillDir);
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Review Coach\n", "utf8");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companySkills).values({
      id: randomUUID(),
      companyId,
      key: `company/${companyId}/review-coach`,
      slug: "review-coach",
      name: "Review Coach",
      description: null,
      markdown: "# Review Coach\n",
      sourceType: "local_path",
      sourceLocator: skillDir,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      metadata: { sourceKind: "local_path" },
    });

    await expect(
      svc.resolveRequestedSkillKeys(companyId, [
        { key: " review-coach ", versionId: "33333333-3333-4333-8333-333333333333" },
        "review-coach",
      ]),
    ).resolves.toEqual([`company/${companyId}/review-coach`]);
    await expect(
      svc.resolveRequestedSkillKeys(companyId, [{ key: "retired-coach", versionId: null }]),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("keeps references an agent already has that no longer match one skill", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    // Two skills share the short name "review-coach".
    for (const key of [`company/${companyId}/review-coach`, "local/abc123/review-coach"]) {
      const skillDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-review-skill-"));
      cleanupDirs.add(skillDir);
      await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Review Coach\n", "utf8");
      await db.insert(companySkills).values({
        id: randomUUID(),
        companyId,
        key,
        slug: "review-coach",
        name: "Review Coach",
        description: null,
        markdown: "# Review Coach\n",
        sourceType: "local_path",
        sourceLocator: skillDir,
        trustLevel: "markdown_only",
        compatibility: "compatible",
        fileInventory: [{ path: "SKILL.md", kind: "skill" }],
        metadata: { sourceKind: "local_path" },
      });
    }
    const saved = ["review-coach", "Retired-Coach"];

    await expect(
      svc.resolveRequestedSkillKeys(
        companyId,
        ["review-coach", { key: "retired-coach", versionId: null }, "local/abc123/review-coach"],
        { keepUnresolved: saved },
      ),
    ).resolves.toEqual(["review-coach", "Retired-Coach", "local/abc123/review-coach"]);
    await expect(
      svc.resolveRequestedSkillKeys(companyId, ["review-coach"]),
    ).rejects.toMatchObject({
      status: 422,
      message: "Invalid company skill selection (ambiguous references: review-coach).",
    });
    await expect(
      svc.resolveRequestedSkillKeys(companyId, ["retired-coach", "missing-coach"], { keepUnresolved: saved }),
    ).rejects.toMatchObject({
      status: 422,
      message: "Invalid company skill selection (unknown references: missing-coach).",
    });
  });
});
