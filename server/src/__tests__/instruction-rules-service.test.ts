import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  companies,
  createDb,
  instructionRuleProposals,
  issueApprovals,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { approvalService } from "../services/approvals.js";
import { instructionRuleService } from "../services/instruction-rules.js";
import { persistActivityLog } from "../services/activity-log.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("instruction rule service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-instruction-rules-");
    db = createDb(tempDb.connectionString);
  }, 90_000);

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

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCorrection() {
    const company = await db
      .insert(companies)
      .values({
        name: `Instruction Rules ${randomUUID()}`,
        issuePrefix: `IR${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
    const [agent, otherAgent] = await db
      .insert(agents)
      .values([
        { companyId: company.id, name: "Corrected agent", role: "engineer" },
        { companyId: company.id, name: "Other agent", role: "engineer" },
      ])
      .returning();
    const issue = await db
      .insert(issues)
      .values({
        companyId: company.id,
        title: "Correct the workflow",
        assigneeAgentId: agent!.id,
      })
      .returning()
      .then((rows) => rows[0]!);
    const comment = await db
      .insert(issueComments)
      .values({
        companyId: company.id,
        issueId: issue.id,
        authorType: "user",
        authorUserId: "board-user",
        intent: "correction",
        expectedAssigneeAgentId: agent!.id,
        body: "Check totals before posting.",
      })
      .returning()
      .then((rows) => rows[0]!);
    return { company, agent: agent!, otherAgent: otherAgent!, issue, comment };
  }

  it("returns one approval when concurrent retries propose the same correction", async () => {
    const seeded = await seedCorrection();
    const service = instructionRuleService(db);
    const payload = {
      version: 1 as const,
      scope: "agent" as const,
      targetAgentId: seeded.agent.id,
      sourceIssueId: seeded.issue.id,
      sourceCommentId: seeded.comment.id,
      rule: "Check totals before posting.",
    };

    const results = await Promise.all(
      Array.from({ length: 4 }, () => service.create({
        companyId: seeded.company.id,
        payload,
        requestedByAgentId: seeded.agent.id,
        linkedIssueIds: [seeded.issue.id],
      })),
    );

    expect(new Set(results.map((result) => result.approval.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await db.select().from(approvals)).toHaveLength(1);
    expect(await db.select().from(instructionRuleProposals)).toHaveLength(1);
    expect(await db.select().from(issueApprovals)).toHaveLength(1);
  });

  it("rolls back creation with its audit row and succeeds cleanly on retry", async () => {
    const seeded = await seedCorrection();
    let failAudit = true;
    const service = instructionRuleService(db, {
      activityRecorder: async (activityDb, input) => {
        if (failAudit) {
          failAudit = false;
          throw new Error("activity insert failed");
        }
        return persistActivityLog(activityDb, input);
      },
    });
    const input = {
      companyId: seeded.company.id,
      payload: {
        version: 1 as const,
        scope: "agent" as const,
        targetAgentId: seeded.agent.id,
        sourceIssueId: seeded.issue.id,
        sourceCommentId: seeded.comment.id,
        rule: "Check totals before posting.",
      },
      requestedByAgentId: seeded.agent.id,
      linkedIssueIds: [seeded.issue.id],
    };

    await expect(service.create(input)).rejects.toThrow("activity insert failed");
    expect(await db.select().from(approvals)).toHaveLength(0);
    expect(await db.select().from(instructionRuleProposals)).toHaveLength(0);
    expect(await db.select().from(issueApprovals)).toHaveLength(0);
    expect(await db.select().from(activityLog)).toHaveLength(0);

    await expect(service.create(input)).resolves.toMatchObject({ created: true });
    expect(await db.select().from(approvals)).toHaveLength(1);
    expect(await db.select().from(activityLog)).toEqual([
      expect.objectContaining({ action: "approval.created" }),
    ]);
  });

  it("rolls back approval, audit rows, and source receipt when audit logging fails, then retries once", async () => {
    const seeded = await seedCorrection();
    let failAppliedAudit = true;
    const service = instructionRuleService(db, {
      activityRecorder: async (activityDb, input) => {
        if (input.action === "approval.instruction_rule_applied" && failAppliedAudit) {
          failAppliedAudit = false;
          throw new Error("applied audit insert failed");
        }
        return persistActivityLog(activityDb, input);
      },
    });
    const created = await service.create({
      companyId: seeded.company.id,
      payload: {
        version: 1,
        scope: "agent",
        targetAgentId: seeded.agent.id,
        sourceIssueId: seeded.issue.id,
        sourceCommentId: seeded.comment.id,
        rule: "Check totals before posting.",
      },
      requestedByAgentId: seeded.agent.id,
      linkedIssueIds: [seeded.issue.id],
    });
    const publishedActions: string[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(seeded.company.id, (event) => {
      if (event.type === "activity.logged" && typeof event.payload.action === "string") {
        publishedActions.push(event.payload.action);
      }
    });

    await expect(service.approve(created.approval.id, "board-user"))
      .rejects.toThrow("applied audit insert failed");
    expect(await db.select().from(approvals).where(eq(approvals.id, created.approval.id)))
      .toEqual([expect.objectContaining({ status: "pending" })]);
    expect(await db.select().from(activityLog)).toEqual([
      expect.objectContaining({ action: "approval.created" }),
    ]);
    expect(await db.select().from(issueComments)).toHaveLength(1);
    expect(publishedActions).toEqual([]);

    await expect(service.approve(created.approval.id, "board-user"))
      .resolves.toMatchObject({ applied: true, approval: { status: "approved" } });
    const auditActions = (await db.select().from(activityLog)).map((row) => row.action);
    expect(auditActions.filter((action) => action === "approval.approved")).toHaveLength(1);
    expect(auditActions.filter((action) => action === "approval.instruction_rule_applied")).toHaveLength(1);
    expect(await db.select().from(issueComments)).toEqual([
      expect.objectContaining({ id: seeded.comment.id, intent: "correction" }),
      expect.objectContaining({
        authorType: "system",
        body: "Approved standing rule (agent): Check totals before posting.",
      }),
    ]);
    expect(publishedActions).toEqual([
      "approval.approved",
      "approval.instruction_rule_applied",
    ]);
    unsubscribe();
  });

  it("ignores unrelated issue links and binds creation only to the correction source", async () => {
    const seeded = await seedCorrection();
    const service = instructionRuleService(db);

    await expect(service.create({
      companyId: seeded.company.id,
      payload: {
        version: 1,
        scope: "agent",
        targetAgentId: seeded.agent.id,
        sourceIssueId: seeded.issue.id,
        sourceCommentId: seeded.comment.id,
        rule: "Check totals before posting.",
      },
      requestedByAgentId: seeded.agent.id,
      linkedIssueIds: [seeded.issue.id, randomUUID()],
    })).resolves.toMatchObject({ created: true });

    expect(await db.select().from(approvals)).toHaveLength(1);
    expect(await db.select().from(instructionRuleProposals)).toHaveLength(1);
    expect(await db.select().from(issueApprovals)).toEqual([
      expect.objectContaining({ issueId: seeded.issue.id }),
    ]);
  });

  it("uses the correction target when the source issue is reassigned before rule creation", async () => {
    const seeded = await seedCorrection();
    await db.update(issues)
      .set({ assigneeAgentId: seeded.otherAgent.id })
      .where(eq(issues.id, seeded.issue.id));

    await expect(instructionRuleService(db).create({
      companyId: seeded.company.id,
      payload: {
        version: 1,
        scope: "agent",
        targetAgentId: seeded.agent.id,
        sourceIssueId: seeded.issue.id,
        sourceCommentId: seeded.comment.id,
        rule: "Check totals before posting.",
      },
      requestedByAgentId: seeded.agent.id,
      linkedIssueIds: [seeded.issue.id],
    })).resolves.toMatchObject({ created: true });
    expect(await db.select().from(approvals)).toHaveLength(1);
    expect(await db.select().from(instructionRuleProposals)).toHaveLength(1);
  });

  it("allows approval after the source issue is reassigned", async () => {
    const seeded = await seedCorrection();
    const service = instructionRuleService(db);
    const created = await service.create({
      companyId: seeded.company.id,
      payload: {
        version: 1,
        scope: "agent",
        targetAgentId: seeded.agent.id,
        sourceIssueId: seeded.issue.id,
        sourceCommentId: seeded.comment.id,
        rule: "Check totals before posting.",
      },
      requestedByAgentId: seeded.agent.id,
      linkedIssueIds: [seeded.issue.id],
    });
    await db
      .update(issues)
      .set({ assigneeAgentId: seeded.otherAgent.id })
      .where(eq(issues.id, seeded.issue.id));

    await expect(
      service.approve(created.approval.id, "board-user"),
    ).resolves.toMatchObject({ applied: true, approval: { status: "approved" } });
    const approval = await db.select().from(approvals).then((rows) => rows[0]!);
    expect(approval.status).toBe("approved");
  });

  it("allows a revision request after the source issue is reassigned", async () => {
    const seeded = await seedCorrection();
    const service = instructionRuleService(db);
    const created = await service.create({
      companyId: seeded.company.id,
      payload: {
        version: 1,
        scope: "agent",
        targetAgentId: seeded.agent.id,
        sourceIssueId: seeded.issue.id,
        sourceCommentId: seeded.comment.id,
        rule: "Check totals before posting.",
      },
      requestedByAgentId: seeded.agent.id,
      linkedIssueIds: [seeded.issue.id],
    });
    await db.update(issues)
      .set({ assigneeAgentId: seeded.otherAgent.id })
      .where(eq(issues.id, seeded.issue.id));

    await expect(
      approvalService(db).requestRevision(created.approval.id, "board-user", "Make the source check explicit."),
    ).resolves.toMatchObject({ applied: true, approval: { status: "revision_requested" } });
    expect(await db.select().from(approvals).where(eq(approvals.id, created.approval.id)))
      .toEqual([expect.objectContaining({ status: "revision_requested" })]);
  });

  it("rejects a revision request after the source correction is deleted", async () => {
    const seeded = await seedCorrection();
    const created = await instructionRuleService(db).create({
      companyId: seeded.company.id,
      payload: {
        version: 1,
        scope: "agent",
        targetAgentId: seeded.agent.id,
        sourceIssueId: seeded.issue.id,
        sourceCommentId: seeded.comment.id,
        rule: "Check totals before posting.",
      },
      requestedByAgentId: seeded.agent.id,
      linkedIssueIds: [seeded.issue.id],
    });
    await db.delete(issueComments).where(eq(issueComments.id, seeded.comment.id));

    await expect(
      approvalService(db).requestRevision(created.approval.id, "board-user", "Make the source check explicit."),
    ).rejects.toThrow("source correction or target agent no longer exists");
    expect(await db.select().from(approvals).where(eq(approvals.id, created.approval.id)))
      .toEqual([expect.objectContaining({ status: "pending" })]);
  });

  it("does not let a concurrent revision request revert an approved instruction rule", async () => {
    const seeded = await seedCorrection();
    const service = instructionRuleService(db);
    const created = await service.create({
      companyId: seeded.company.id,
      payload: {
        version: 1,
        scope: "agent",
        targetAgentId: seeded.agent.id,
        sourceIssueId: seeded.issue.id,
        sourceCommentId: seeded.comment.id,
        rule: "Check totals before posting.",
      },
      requestedByAgentId: seeded.agent.id,
      linkedIssueIds: [seeded.issue.id],
    });

    const outcomes = await Promise.allSettled([
      service.approve(created.approval.id, "board-user"),
      approvalService(db).requestRevision(created.approval.id, "board-user", "Tighten it"),
    ]);

    if (outcomes[0]?.status === "rejected") throw outcomes[0].reason;
    const stored = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, created.approval.id))
      .then((rows) => rows[0]!);
    expect(stored.status).toBe("approved");
  });

  it("does not let a concurrent resubmit reopen an approved instruction rule", async () => {
    const seeded = await seedCorrection();
    const service = instructionRuleService(db);
    const originalPayload = {
      version: 1 as const,
      scope: "agent" as const,
      targetAgentId: seeded.agent.id,
      sourceIssueId: seeded.issue.id,
      sourceCommentId: seeded.comment.id,
      rule: "Check totals before posting.",
    };
    const created = await service.create({
      companyId: seeded.company.id,
      payload: originalPayload,
      requestedByAgentId: seeded.agent.id,
      linkedIssueIds: [seeded.issue.id],
    });
    const revision = await approvalService(db).requestRevision(created.approval.id, "board-user", "Make it explicit");
    const revisedPayload = {
      ...originalPayload,
      rule: "Recalculate and check totals before posting.",
    };

    const outcomes = await Promise.allSettled([
      service.approve(created.approval.id, "board-user"),
      service.resubmit(created.approval.id, revisedPayload, revision.approval.decidedAt!.toISOString()),
    ]);

    if (outcomes[0]?.status === "rejected") throw outcomes[0].reason;
    const stored = await db
      .select({ approval: approvals, proposal: instructionRuleProposals })
      .from(approvals)
      .innerJoin(instructionRuleProposals, eq(instructionRuleProposals.approvalId, approvals.id))
      .where(eq(approvals.id, created.approval.id))
      .then((rows) => rows[0]!);
    expect(stored.approval.status).toBe("approved");
    expect(stored.proposal.rule).toBe(
      (stored.approval.payload as { rule: string }).rule,
    );
  });

  it("rejects a delayed resubmit from an older revision cycle", async () => {
    const seeded = await seedCorrection();
    const service = instructionRuleService(db);
    const originalPayload = {
      version: 1 as const,
      scope: "agent" as const,
      targetAgentId: seeded.agent.id,
      sourceIssueId: seeded.issue.id,
      sourceCommentId: seeded.comment.id,
      rule: "Check totals before posting.",
    };
    const created = await service.create({
      companyId: seeded.company.id,
      payload: originalPayload,
      requestedByAgentId: seeded.agent.id,
      linkedIssueIds: [seeded.issue.id],
    });
    const first = await approvalService(db).requestRevision(created.approval.id, "board-user", "First revision.");
    const firstPayload = { ...originalPayload, rule: "Check totals against the source before posting." };
    await service.resubmit(created.approval.id, firstPayload, first.approval.decidedAt!.toISOString());
    const second = await approvalService(db).requestRevision(created.approval.id, "board-user", "Second revision.");

    await expect(
      service.resubmit(
        created.approval.id,
        { ...originalPayload, rule: "A delayed stale replacement." },
        first.approval.decidedAt!.toISOString(),
      ),
    ).rejects.toThrow("superseded");
    expect(await db.select().from(approvals).where(eq(approvals.id, created.approval.id)))
      .toEqual([expect.objectContaining({ status: "revision_requested", payload: firstPayload })]);

    await expect(
      service.resubmit(
        created.approval.id,
        { ...originalPayload, rule: "Check totals and cite the source before posting." },
        second.approval.decidedAt!.toISOString(),
      ),
    ).resolves.toMatchObject({ status: "pending" });
  });

  it("uses the correction target when the source issue is reassigned before resubmit", async () => {
    const seeded = await seedCorrection();
    const service = instructionRuleService(db);
    const payload = {
      version: 1 as const,
      scope: "agent" as const,
      targetAgentId: seeded.agent.id,
      sourceIssueId: seeded.issue.id,
      sourceCommentId: seeded.comment.id,
      rule: "Check totals before posting.",
    };
    const created = await service.create({
      companyId: seeded.company.id,
      payload,
      requestedByAgentId: seeded.agent.id,
      linkedIssueIds: [seeded.issue.id],
    });
    const revision = await approvalService(db).requestRevision(created.approval.id, "board-user", "Make it explicit.");
    await db.update(issues)
      .set({ assigneeAgentId: seeded.otherAgent.id })
      .where(eq(issues.id, seeded.issue.id));

    await expect(
      service.resubmit(
        created.approval.id,
        { ...payload, rule: "Check and cite totals before posting." },
        revision.approval.decidedAt!.toISOString(),
      ),
    ).resolves.toMatchObject({ status: "pending" });
    expect(await db.select().from(approvals).where(eq(approvals.id, created.approval.id)))
      .toEqual([expect.objectContaining({ status: "pending" })]);
  });

  it("rejects an approval that would exceed the standing rule capacity", async () => {
    const seeded = await seedCorrection();
    const secondComment = await db
      .insert(issueComments)
      .values({
        companyId: seeded.company.id,
        issueId: seeded.issue.id,
        authorType: "user",
        authorUserId: "board-user",
        intent: "correction",
        expectedAssigneeAgentId: seeded.agent.id,
        body: "Keep all approved rules available.",
      })
      .returning()
      .then((rows) => rows[0]!);
    const service = instructionRuleService(db);
    const first = await service.create({
      companyId: seeded.company.id,
      payload: {
        version: 1,
        scope: "company",
        targetAgentId: seeded.agent.id,
        sourceIssueId: seeded.issue.id,
        sourceCommentId: seeded.comment.id,
        rule: "A".repeat(4_000),
      },
      requestedByAgentId: seeded.agent.id,
      linkedIssueIds: [seeded.issue.id],
    });
    const second = await service.create({
      companyId: seeded.company.id,
      payload: {
        version: 1,
        scope: "company",
        targetAgentId: seeded.agent.id,
        sourceIssueId: seeded.issue.id,
        sourceCommentId: secondComment.id,
        rule: "B".repeat(4_000),
      },
      requestedByAgentId: seeded.agent.id,
      linkedIssueIds: [seeded.issue.id],
    });

    await expect(service.approve(first.approval.id, "board-user")).resolves.toMatchObject({ applied: true });
    expect(await service.listApprovedForAgent(seeded.company.id, seeded.otherAgent.id)).toEqual([
      expect.objectContaining({ approvalId: first.approval.id, rule: "A".repeat(4_000) }),
    ]);
    await expect(service.approve(second.approval.id, "board-user")).rejects.toThrow("standing-rule limit");
    const statuses = await db.select({ id: approvals.id, status: approvals.status }).from(approvals);
    expect(statuses.find((row) => row.id === first.approval.id)?.status).toBe("approved");
    expect(statuses.find((row) => row.id === second.approval.id)?.status).toBe("pending");
  });

  it("excludes terminated agents from company rule capacity but retains paused agents", async () => {
    const seeded = await seedCorrection();
    const service = instructionRuleService(db);
    const otherIssue = await db
      .insert(issues)
      .values({
        companyId: seeded.company.id,
        title: "Correct the other agent",
        assigneeAgentId: seeded.otherAgent.id,
      })
      .returning()
      .then((rows) => rows[0]!);
    const otherComment = await db
      .insert(issueComments)
      .values({
        companyId: seeded.company.id,
        issueId: otherIssue.id,
        authorType: "user",
        authorUserId: "board-user",
        intent: "correction",
        expectedAssigneeAgentId: seeded.otherAgent.id,
        body: "Keep this agent-specific rule available.",
      })
      .returning()
      .then((rows) => rows[0]!);
    const agentRule = await service.create({
      companyId: seeded.company.id,
      payload: {
        version: 1,
        scope: "agent",
        targetAgentId: seeded.otherAgent.id,
        sourceIssueId: otherIssue.id,
        sourceCommentId: otherComment.id,
        rule: "A".repeat(7_800),
      },
      requestedByAgentId: seeded.otherAgent.id,
      linkedIssueIds: [otherIssue.id],
    });
    await expect(service.approve(agentRule.approval.id, "board-user")).resolves.toMatchObject({ applied: true });

    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, seeded.otherAgent.id));
    const firstCompanyRule = await service.create({
      companyId: seeded.company.id,
      payload: {
        version: 1,
        scope: "company",
        targetAgentId: seeded.agent.id,
        sourceIssueId: seeded.issue.id,
        sourceCommentId: seeded.comment.id,
        rule: "B".repeat(300),
      },
      requestedByAgentId: seeded.agent.id,
      linkedIssueIds: [seeded.issue.id],
    });
    await expect(service.approve(firstCompanyRule.approval.id, "board-user")).resolves.toMatchObject({ applied: true });

    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, seeded.otherAgent.id));
    const secondComment = await db
      .insert(issueComments)
      .values({
        companyId: seeded.company.id,
        issueId: seeded.issue.id,
        authorType: "user",
        authorUserId: "board-user",
        intent: "correction",
        expectedAssigneeAgentId: seeded.agent.id,
        body: "Keep paused agents within standing rule capacity.",
      })
      .returning()
      .then((rows) => rows[0]!);
    const secondCompanyRule = await service.create({
      companyId: seeded.company.id,
      payload: {
        version: 1,
        scope: "company",
        targetAgentId: seeded.agent.id,
        sourceIssueId: seeded.issue.id,
        sourceCommentId: secondComment.id,
        rule: "C".repeat(300),
      },
      requestedByAgentId: seeded.agent.id,
      linkedIssueIds: [seeded.issue.id],
    });
    await expect(service.approve(secondCompanyRule.approval.id, "board-user")).rejects.toThrow("standing-rule limit");
  });
});
