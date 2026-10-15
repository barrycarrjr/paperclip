import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  companies,
  instructionRuleProposals,
  issueApprovals,
  issueComments,
  issues,
} from "@paperclipai/db";
import type { InstructionChangePayload } from "@paperclipai/shared";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { notFound, unprocessable } from "../errors.js";
import {
  persistActivityLog,
  publishPersistedActivityLog,
  type LogActivityInput,
  type PersistedActivityLogInput,
} from "./activity-log.js";

export const APPROVED_INSTRUCTION_RULES_MAX_CHARS = 8_000;

export interface ApprovedInstructionRule {
  approvalId: string;
  scope: "agent" | "company";
  targetAgentId: string | null;
  rule: string;
}

const APPROVED_RULES_HEADER = [
  "Paperclip approved standing rules:",
  "These rules were approved by the board and are part of your persistent operating instructions.",
];

export function buildApprovedInstructionRulesMarkdown(rows: ApprovedInstructionRule[]): string | null {
  if (rows.length === 0) return null;
  return [
    ...APPROVED_RULES_HEADER,
    ...rows.map((row) => `- [${row.scope}; approval ${row.approvalId}] ${row.rule}`),
  ].join("\n");
}

function rulesFitEveryAgent(
  agentIds: string[],
  rows: ApprovedInstructionRule[],
): boolean {
  return agentIds.every((agentId) => {
    const applicable = rows.filter((row) => row.scope === "company" || row.targetAgentId === agentId);
    const markdown = buildApprovedInstructionRulesMarkdown(applicable);
    return !markdown || markdown.length <= APPROVED_INSTRUCTION_RULES_MAX_CHARS;
  });
}

type ActivityRecorder = (db: Db, input: LogActivityInput) => Promise<PersistedActivityLogInput>;

export function instructionRuleService(
  db: Db,
  deps: { activityRecorder?: ActivityRecorder } = {},
) {
  const activityRecorder = deps.activityRecorder ?? persistActivityLog;
  async function findBySourceAndAgent(sourceCommentId: string, targetAgentId: string) {
    return db
      .select({ approval: approvals })
      .from(instructionRuleProposals)
      .innerJoin(approvals, eq(approvals.id, instructionRuleProposals.approvalId))
      .where(and(
        eq(instructionRuleProposals.sourceCommentId, sourceCommentId),
        eq(instructionRuleProposals.targetAgentId, targetAgentId),
      ))
      .then((rows) => rows[0]?.approval ?? null);
  }

  return {
    create: async (input: {
      companyId: string;
      payload: InstructionChangePayload;
      requestedByAgentId: string;
      linkedIssueIds: string[];
    }) => {
      const linkedIssueIds = [input.payload.sourceIssueId];
      // A board correction has one proposal for its assigned agent. Retries
      // return that approval instead of creating a second decision record.
      const existing = await findBySourceAndAgent(input.payload.sourceCommentId, input.payload.targetAgentId);
      if (existing) return { approval: existing, created: false };

      let transactionResult: {
        approval: typeof approvals.$inferSelect;
        created: true;
        activity: PersistedActivityLogInput;
      };
      try {
        transactionResult = await db.transaction(async (tx) => {
          await tx.select({ id: companies.id }).from(companies)
            .where(eq(companies.id, input.companyId)).for("update");
          const source = await tx
            .select({
              intent: issueComments.intent,
              authorUserId: issueComments.authorUserId,
              assigneeAgentId: issues.assigneeAgentId,
            })
            .from(issueComments)
            .innerJoin(issues, eq(issues.id, issueComments.issueId))
            .where(and(
              eq(issueComments.id, input.payload.sourceCommentId),
              eq(issueComments.issueId, input.payload.sourceIssueId),
              eq(issueComments.companyId, input.companyId),
              eq(issues.companyId, input.companyId),
            ))
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (!source || source.intent !== "correction" || !source.authorUserId) {
            throw unprocessable("Instruction changes require a board-authored correction comment");
          }
          if (
            input.requestedByAgentId !== input.payload.targetAgentId ||
            source.assigneeAgentId !== input.payload.targetAgentId
          ) {
            throw unprocessable("The correction is no longer assigned to the requesting agent");
          }

          const approval = await tx
            .insert(approvals)
            .values({
              companyId: input.companyId,
              type: "instruction_change",
              requestedByAgentId: input.requestedByAgentId,
              requestedByUserId: null,
              status: "pending",
              payload: input.payload,
              decisionNote: null,
              decidedByUserId: null,
              decidedAt: null,
              updatedAt: new Date(),
            })
            .returning()
            .then((rows) => rows[0]!);

          const linkedIssues = await tx
            .select({ id: issues.id, companyId: issues.companyId })
            .from(issues)
            .where(inArray(issues.id, linkedIssueIds));
          if (linkedIssues.length !== linkedIssueIds.length) {
            throw notFound("One or more issues not found");
          }
          if (linkedIssues.some((issue) => issue.companyId !== input.companyId)) {
            throw unprocessable("Issue and approval must belong to the same company");
          }

          await tx.insert(instructionRuleProposals).values({
            companyId: input.companyId,
            approvalId: approval.id,
            sourceIssueId: input.payload.sourceIssueId,
            sourceCommentId: input.payload.sourceCommentId,
            targetAgentId: input.payload.targetAgentId,
            scope: input.payload.scope,
            rule: input.payload.rule,
            rationale: input.payload.rationale ?? null,
          });

          if (linkedIssueIds.length > 0) {
            await tx
              .insert(issueApprovals)
              .values(linkedIssueIds.map((issueId) => ({
                companyId: input.companyId,
                issueId,
                approvalId: approval.id,
                linkedByAgentId: input.requestedByAgentId,
                linkedByUserId: null,
              })))
              .onConflictDoNothing();
          }

          const activity = await activityRecorder(tx as unknown as Db, {
            companyId: input.companyId,
            actorType: "agent",
            actorId: input.requestedByAgentId,
            agentId: input.requestedByAgentId,
            action: "approval.created",
            entityType: "approval",
            entityId: approval.id,
            details: { type: approval.type, issueIds: linkedIssueIds },
          });

          return { approval, created: true as const, activity };
        });
      } catch (error) {
        const raced = await findBySourceAndAgent(input.payload.sourceCommentId, input.payload.targetAgentId);
        if (raced) return { approval: raced, created: false };
        throw error;
      }
      publishPersistedActivityLog(transactionResult.activity);
      return { approval: transactionResult.approval, created: true };
    },

    resubmit: async (approvalId: string, payload: InstructionChangePayload, revisionCycle: string) =>
      db.transaction(async (tx) => {
        const approvalCompany = await tx
          .select({ companyId: approvals.companyId })
          .from(approvals)
          .where(eq(approvals.id, approvalId))
          .then((rows) => rows[0] ?? null);
        if (!approvalCompany) {
          throw unprocessable("Only revision requested approvals can be resubmitted");
        }

        // Approval and resubmit take locks in the same order. This prevents a
        // deadlock and makes one operation observe the other's committed state.
        await tx
          .select({ id: companies.id })
          .from(companies)
          .where(eq(companies.id, approvalCompany.companyId))
          .for("update");
        const candidate = await tx
          .select({ approval: approvals, proposal: instructionRuleProposals })
          .from(approvals)
          .innerJoin(instructionRuleProposals, eq(instructionRuleProposals.approvalId, approvals.id))
          .where(eq(approvals.id, approvalId))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!candidate || candidate.approval.status !== "revision_requested") {
          throw unprocessable("Only revision requested approvals can be resubmitted");
        }
        const currentCycle = candidate.approval.decidedAt?.toISOString() ?? null;
        if (!currentCycle || revisionCycle !== currentCycle) {
          throw unprocessable("This instruction revision request has been superseded");
        }
        if (
          payload.targetAgentId !== candidate.proposal.targetAgentId ||
          payload.sourceIssueId !== candidate.proposal.sourceIssueId ||
          payload.sourceCommentId !== candidate.proposal.sourceCommentId
        ) {
          throw unprocessable("A revised rule cannot change its agent or source correction");
        }
        const source = await tx
          .select({
            intent: issueComments.intent,
            authorUserId: issueComments.authorUserId,
            assigneeAgentId: issues.assigneeAgentId,
          })
          .from(issueComments)
          .innerJoin(issues, eq(issues.id, issueComments.issueId))
          .where(and(
            eq(issueComments.id, payload.sourceCommentId),
            eq(issueComments.issueId, payload.sourceIssueId),
            eq(issueComments.companyId, candidate.approval.companyId),
            eq(issues.companyId, candidate.approval.companyId),
          ))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (
          !source || source.intent !== "correction" || !source.authorUserId ||
          source.assigneeAgentId !== payload.targetAgentId
        ) {
          throw unprocessable("The source correction is no longer assigned to the target agent, so the rule cannot be resubmitted");
        }
        const now = new Date(Math.max(Date.now(), candidate.approval.updatedAt.getTime() + 1));
        await tx
          .update(instructionRuleProposals)
          .set({
            scope: payload.scope,
            rule: payload.rule,
            rationale: payload.rationale ?? null,
            updatedAt: now,
          })
          .where(eq(instructionRuleProposals.approvalId, approvalId));
        const updated = await tx
          .update(approvals)
          .set({
            status: "pending",
            payload,
            decisionNote: null,
            decidedByUserId: null,
            decidedAt: null,
            updatedAt: now,
          })
          .where(and(
            eq(approvals.id, approvalId),
            eq(approvals.status, "revision_requested"),
          ))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) {
          // Throwing rolls back the proposal edit as well as the failed state
          // transition, so a concurrent terminal decision stays immutable.
          throw unprocessable("Only revision requested approvals can be resubmitted");
        }
        return updated;
      }),

    requestRevision: async (approvalId: string, decidedByUserId: string, decisionNote: string) =>
      db.transaction(async (tx) => {
        const approvalCompany = await tx
          .select({ companyId: approvals.companyId })
          .from(approvals)
          .where(eq(approvals.id, approvalId))
          .then((rows) => rows[0] ?? null);
        if (!approvalCompany) throw unprocessable("Only pending approvals can request revision");

        await tx
          .select({ id: companies.id })
          .from(companies)
          .where(eq(companies.id, approvalCompany.companyId))
          .for("update");
        const candidate = await tx
          .select({ approval: approvals, proposal: instructionRuleProposals })
          .from(approvals)
          .innerJoin(instructionRuleProposals, eq(instructionRuleProposals.approvalId, approvals.id))
          .where(eq(approvals.id, approvalId))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!candidate) throw unprocessable("Instruction rule proposal not found");
        if (candidate.approval.status === "revision_requested") {
          return { approval: candidate.approval, applied: false as const };
        }
        if (candidate.approval.status !== "pending") {
          throw unprocessable("Only pending approvals can request revision");
        }
        if (!candidate.proposal.sourceIssueId || !candidate.proposal.sourceCommentId || !candidate.proposal.targetAgentId) {
          throw unprocessable("The source correction or target agent no longer exists, so revision cannot be requested");
        }

        const source = await tx
          .select({
            intent: issueComments.intent,
            authorUserId: issueComments.authorUserId,
            assigneeAgentId: issues.assigneeAgentId,
          })
          .from(issueComments)
          .innerJoin(issues, eq(issues.id, issueComments.issueId))
          .where(and(
            eq(issueComments.id, candidate.proposal.sourceCommentId),
            eq(issueComments.issueId, candidate.proposal.sourceIssueId),
            eq(issueComments.companyId, candidate.approval.companyId),
            eq(issues.companyId, candidate.approval.companyId),
          ))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (
          !source || source.intent !== "correction" || !source.authorUserId ||
          source.assigneeAgentId !== candidate.proposal.targetAgentId
        ) {
          throw unprocessable("The source correction is no longer assigned to the target agent, so revision cannot be requested");
        }

        const now = new Date(Math.max(Date.now(), candidate.approval.updatedAt.getTime() + 1));
        const approval = await tx
          .update(approvals)
          .set({
            status: "revision_requested",
            decidedByUserId,
            decisionNote,
            decidedAt: now,
            updatedAt: now,
          })
          .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!approval) throw unprocessable("Only pending approvals can request revision");
        return { approval, applied: true as const };
      }),

    approve: async (
      approvalId: string,
      decidedByUserId: string,
      decisionNote?: string | null,
      activityDetails: Record<string, unknown> = {},
    ) => {
      const transactionResult = await db.transaction(async (tx) => {
        const approvalCompany = await tx
          .select({ companyId: approvals.companyId })
          .from(approvals)
          .where(eq(approvals.id, approvalId))
          .then((rows) => rows[0] ?? null);
        if (!approvalCompany) throw unprocessable("Instruction rule proposal not found");

        await tx
          .select({ id: companies.id })
          .from(companies)
          .where(eq(companies.id, approvalCompany.companyId))
          .for("update");

        const candidate = await tx
          .select({ approval: approvals, proposal: instructionRuleProposals })
          .from(approvals)
          .innerJoin(instructionRuleProposals, eq(instructionRuleProposals.approvalId, approvals.id))
          .where(eq(approvals.id, approvalId))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!candidate) throw unprocessable("Instruction rule proposal not found");

        if (candidate.approval.status === "approved") {
          return { approval: candidate.approval, applied: false as const, activities: [] };
        }
        if (!["pending", "revision_requested"].includes(candidate.approval.status)) {
          throw unprocessable("Only pending or revision requested approvals can be approved");
        }

        // Deleting source evidence must not remove an already approved rule,
        // but an undecided proposal still requires its original correction.
        if (!candidate.proposal.sourceIssueId || !candidate.proposal.sourceCommentId || !candidate.proposal.targetAgentId) {
          throw unprocessable("The source correction or target agent no longer exists, so the rule was not approved");
        }

        const source = await tx
          .select({
            intent: issueComments.intent,
            authorUserId: issueComments.authorUserId,
            assigneeAgentId: issues.assigneeAgentId,
          })
          .from(issueComments)
          .innerJoin(issues, eq(issues.id, issueComments.issueId))
          .where(and(
            eq(issueComments.id, candidate.proposal.sourceCommentId),
            eq(issueComments.issueId, candidate.proposal.sourceIssueId),
            eq(issueComments.companyId, candidate.approval.companyId),
            eq(issues.companyId, candidate.approval.companyId),
          ))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (
          !source ||
          source.intent !== "correction" ||
          !source.authorUserId ||
          source.assigneeAgentId !== candidate.proposal.targetAgentId
        ) {
          throw unprocessable("The source correction is no longer assigned to the target agent, so the rule was not approved");
        }

        const companyAgents = await tx
          .select({ id: agents.id })
          .from(agents)
          .where(and(
            eq(agents.companyId, candidate.approval.companyId),
            ne(agents.status, "terminated"),
          ));
        const approvedRows = await tx
          .select({
            approvalId: approvals.id,
            scope: instructionRuleProposals.scope,
            targetAgentId: instructionRuleProposals.targetAgentId,
            rule: instructionRuleProposals.rule,
          })
          .from(instructionRuleProposals)
          .innerJoin(approvals, eq(approvals.id, instructionRuleProposals.approvalId))
          .where(and(
            eq(instructionRuleProposals.companyId, candidate.approval.companyId),
            eq(approvals.status, "approved"),
          ))
          .orderBy(asc(instructionRuleProposals.createdAt));
        const allRules: ApprovedInstructionRule[] = [
          ...approvedRows.map((row) => ({
            approvalId: row.approvalId,
            scope: row.scope as "agent" | "company",
            targetAgentId: row.targetAgentId,
            rule: row.rule,
          })),
          {
            approvalId: candidate.approval.id,
            scope: candidate.proposal.scope as "agent" | "company",
            targetAgentId: candidate.proposal.targetAgentId,
            rule: candidate.proposal.rule,
          },
        ];
        const agentIds = Array.from(new Set([
          ...companyAgents.map((agent) => agent.id),
          candidate.proposal.targetAgentId,
        ]));
        if (!rulesFitEveryAgent(agentIds, allRules)) {
          throw unprocessable(
            `Approving this rule would exceed the ${APPROVED_INSTRUCTION_RULES_MAX_CHARS}-character standing-rule limit`,
          );
        }

        const now = new Date();
        const approval = await tx
          .update(approvals)
          .set({
            status: "approved",
            decidedByUserId,
            decisionNote: decisionNote ?? null,
            decidedAt: now,
            updatedAt: now,
          })
          .where(and(
            eq(approvals.id, approvalId),
            inArray(approvals.status, ["pending", "revision_requested"]),
          ))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!approval) {
          const latest = await tx
            .select()
            .from(approvals)
            .where(eq(approvals.id, approvalId))
            .then((rows) => rows[0]!);
          if (latest.status === "approved") {
            return { approval: latest, applied: false as const, activities: [] };
          }
          throw unprocessable("Only pending or revision requested approvals can be approved");
        }

        const linkedIssueIds = await tx
          .select({ issueId: issueApprovals.issueId })
          .from(issueApprovals)
          .where(eq(issueApprovals.approvalId, approval.id))
          .then((rows) => rows.map((row) => row.issueId));
        const approvedActivity = await activityRecorder(tx as unknown as Db, {
          companyId: approval.companyId,
          actorType: "user",
          actorId: decidedByUserId,
          action: "approval.approved",
          entityType: "approval",
          entityId: approval.id,
          details: {
            type: approval.type,
            requestedByAgentId: approval.requestedByAgentId,
            linkedIssueIds,
            ...activityDetails,
          },
        });
        const appliedActivity = await activityRecorder(tx as unknown as Db, {
          companyId: approval.companyId,
          actorType: "user",
          actorId: decidedByUserId,
          action: "approval.instruction_rule_applied",
          entityType: "approval",
          entityId: approval.id,
          details: {
            scope: candidate.proposal.scope,
            targetAgentId: candidate.proposal.targetAgentId,
            sourceIssueId: candidate.proposal.sourceIssueId,
            sourceCommentId: candidate.proposal.sourceCommentId,
            ...activityDetails,
          },
        });

        await tx.insert(issueComments).values({
          companyId: approval.companyId,
          issueId: candidate.proposal.sourceIssueId,
          authorType: "system",
          intent: "message",
          body: `Approved standing rule (${candidate.proposal.scope}): ${candidate.proposal.rule}`,
        });
        await tx
          .update(issues)
          .set({ updatedAt: now })
          .where(eq(issues.id, candidate.proposal.sourceIssueId));
        return {
          approval,
          applied: true as const,
          activities: [approvedActivity, appliedActivity],
        };
      });
      for (const activity of transactionResult.activities) {
        publishPersistedActivityLog(activity);
      }
      return {
        approval: transactionResult.approval,
        applied: transactionResult.applied,
      };
    },

    listApprovedForAgent: async (companyId: string, agentId: string): Promise<ApprovedInstructionRule[]> => {
      const rows = await db
        .select({
          approvalId: approvals.id,
          scope: instructionRuleProposals.scope,
          targetAgentId: instructionRuleProposals.targetAgentId,
          rule: instructionRuleProposals.rule,
        })
        .from(instructionRuleProposals)
        .innerJoin(approvals, eq(approvals.id, instructionRuleProposals.approvalId))
        .where(and(
          eq(instructionRuleProposals.companyId, companyId),
          eq(approvals.status, "approved"),
        ))
        .orderBy(asc(instructionRuleProposals.createdAt));
      return rows
        .filter((row) => row.scope === "company" || row.targetAgentId === agentId)
        .map((row) => ({
          approvalId: row.approvalId,
          scope: row.scope as "agent" | "company",
          targetAgentId: row.targetAgentId,
          rule: row.rule,
        }));
    },
  };
}
