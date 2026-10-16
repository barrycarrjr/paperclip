import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog, agents, approvals, companies, createDb, instructionRuleProposals,
  issueApprovals, issueComments, issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";
import { companyService } from "../services/companies.js";
import { issueService } from "../services/issues.js";
import { instructionRuleService } from "../services/instruction-rules.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("instruction rule deletion", () => {
  let db!: ReturnType<typeof createDb>;
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("paperclip-rule-deletion-");
    db = createDb(testDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(instructionRuleProposals);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => { await testDb?.cleanup(); });

  async function seed() {
    const [company] = await db.insert(companies).values({
      name: "Deletion regression",
      issuePrefix: `DR${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    }).returning();
    const [target, other] = await db.insert(agents).values([
      { companyId: company!.id, name: "Target", role: "engineer" },
      { companyId: company!.id, name: "Other", role: "engineer" },
    ]).returning();
    const [issue] = await db.insert(issues).values({
      companyId: company!.id, title: "Source correction", assigneeAgentId: target!.id,
    }).returning();
    const service = instructionRuleService(db);
    async function propose(scope: "company" | "agent" = "agent") {
      const [comment] = await db.insert(issueComments).values({
        companyId: company!.id, issueId: issue!.id, authorType: "user",
        authorUserId: "board-user", intent: "correction", expectedAssigneeAgentId: target!.id,
        body: "Check totals.",
      }).returning();
      const result = await service.create({
        companyId: company!.id,
        requestedByAgentId: target!.id,
        linkedIssueIds: [issue!.id],
        payload: { version: 1, scope, targetAgentId: target!.id,
          sourceIssueId: issue!.id, sourceCommentId: comment!.id, rule: "Check totals." },
      });
      return { approval: result.approval, comment: comment! };
    }
    return { company: company!, target: target!, other: other!, issue: issue!, service, propose };
  }

  it("deletes a company with pending and approved proposals without affecting another company", async () => {
    const source = await seed();
    await source.propose();
    const approved = await source.propose("company");
    await source.service.approve(approved.approval.id, "board-user");
    const survivor = await seed();
    const retained = await survivor.propose();

    await expect(companyService(db).remove(source.company.id)).resolves.toMatchObject({ id: source.company.id });
    expect(await db.select().from(instructionRuleProposals)).toEqual([
      expect.objectContaining({ approvalId: retained.approval.id, companyId: survivor.company.id }),
    ]);
    expect(await db.select().from(companies).where(eq(companies.id, source.company.id))).toEqual([]);
    expect(await db.select().from(companies).where(eq(companies.id, survivor.company.id))).toHaveLength(1);
    expect(await db.select().from(approvals)).toHaveLength(1);
  });

  it.each(["issue", "comment"] as const)("preserves an approved rule when its source %s is deleted", async (source) => {
    const seeded = await seed();
    const proposal = await seeded.propose();
    await seeded.service.approve(proposal.approval.id, "board-user");
    if (source === "issue") {
      await expect(issueService(db).remove(seeded.issue.id)).resolves.toMatchObject({ id: seeded.issue.id });
    } else {
      await db.delete(issueComments).where(eq(issueComments.id, proposal.comment.id));
    }

    expect(await seeded.service.listApprovedForAgent(seeded.company.id, seeded.target.id)).toEqual([
      expect.objectContaining({ approvalId: proposal.approval.id, rule: "Check totals." }),
    ]);
    const [stored] = await db.select().from(instructionRuleProposals);
    expect(stored?.sourceCommentId).toBeNull();
    if (source === "issue") expect(stored?.sourceIssueId).toBeNull();
  });

  it.each(["issue", "comment"] as const)("cannot approve a pending rule after its source %s is deleted", async (source) => {
    const seeded = await seed();
    const proposal = await seeded.propose();
    if (source === "issue") {
      await issueService(db).remove(seeded.issue.id);
    } else {
      await db.delete(issueComments).where(eq(issueComments.id, proposal.comment.id));
    }

    await expect(seeded.service.approve(proposal.approval.id, "board-user")).rejects.toThrow("no longer exists");
    expect(await db.select().from(approvals)).toEqual([expect.objectContaining({ status: "pending" })]);
    expect(await seeded.service.listApprovedForAgent(seeded.company.id, seeded.target.id)).toEqual([]);
  });

  it("deletes a target agent while retaining approved company rules and preventing new approval", async () => {
    const seeded = await seed();
    const companyRule = await seeded.propose("company");
    await seeded.service.approve(companyRule.approval.id, "board-user");
    const agentRule = await seeded.propose();
    await seeded.service.approve(agentRule.approval.id, "board-user");
    const pending = await seeded.propose("company");

    await expect(agentService(db).remove(seeded.target.id)).resolves.toMatchObject({ id: seeded.target.id });
    expect(await seeded.service.listApprovedForAgent(seeded.company.id, seeded.other.id)).toEqual([
      expect.objectContaining({ approvalId: companyRule.approval.id, scope: "company", targetAgentId: null }),
    ]);
    expect(await db.select().from(instructionRuleProposals)).toHaveLength(3);
    expect((await db.select().from(approvals)).every((row) => row.requestedByAgentId === null)).toBe(true);
    const retainedCorrectionTargets = await db
      .select({ expectedAssigneeAgentId: issueComments.expectedAssigneeAgentId })
      .from(issueComments)
      .where(eq(issueComments.intent, "correction"));
    expect(retainedCorrectionTargets).toEqual([
      { expectedAssigneeAgentId: seeded.target.id },
      { expectedAssigneeAgentId: seeded.target.id },
      { expectedAssigneeAgentId: seeded.target.id },
    ]);
    await expect(seeded.service.approve(pending.approval.id, "board-user")).rejects.toThrow("no longer exists");
  });
});
