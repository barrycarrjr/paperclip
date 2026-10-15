import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, approvals, companies, heartbeatRuns } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { deterministicActivityId, logActivity } from "./activity-log.js";
import { structuralFindingService } from "./structural-findings.js";

const REVIEW_ACTION = "agent_action.permission_review_flagged";
const REVIEW_ACTOR_ID = "scheduled-action-permission-review";

function reviewDayFor(now: Date): { day: string; start: Date } {
  const day = now.toISOString().slice(0, 10);
  return { day, start: new Date(`${day}T00:00:00.000Z`) };
}

async function durableRunId(
  db: Db,
  value: unknown,
  companyId: string,
  agentId: string | null,
): Promise<string | null> {
  if (typeof value !== "string" || !isUuidLike(value) || !agentId || !isUuidLike(agentId)) {
    return null;
  }
  const [run] = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.id, value),
      eq(heartbeatRuns.companyId, companyId),
      eq(heartbeatRuns.agentId, agentId),
    ))
    .limit(1);
  return run?.id ?? null;
}

export function agentActionPermissionReviewService(db: Db) {
  const findings = structuralFindingService(db);

  async function reconcileApprovalAudit(input: {
    companyId: string;
    approvalId: string;
    actorId: string;
    agentId: string | null;
    actionActorId: string | null;
    runId: string | null;
    details: Record<string, unknown> | null;
    executionAttemptId?: string;
    missingOutcomeUncertain: boolean;
  }): Promise<boolean> {
    const receiptId = deterministicActivityId("approval-execution-receipt", input.approvalId);
    const outcomeId = deterministicActivityId("agent-action-outcome", input.approvalId);
    const [storedReceipt, storedOutcome] = await Promise.all([
      db
        .select({ action: activityLog.action, details: activityLog.details })
        .from(activityLog)
        .where(eq(activityLog.id, receiptId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ action: activityLog.action, details: activityLog.details })
        .from(activityLog)
        .where(eq(activityLog.id, outcomeId))
        .then((rows) => rows[0] ?? null),
    ]);
    let repaired = false;
    let receipt = storedReceipt;

    if (!receipt) {
      const receiptAction = storedOutcome?.action === "agent_action.allowed"
        ? "approval.executed"
        : "approval.execute_failed";
      const outcome = storedOutcome?.action === "agent_action.allowed"
        ? "allowed"
        : storedOutcome?.action === "agent_action.refused"
          ? "refused"
          : "failed";
      const outcomeUncertain = storedOutcome
        ? storedOutcome.details?.outcomeUncertain === true
        : input.missingOutcomeUncertain;
      const inserted = await logActivity(db, {
        id: receiptId,
        companyId: input.companyId,
        actorType: "user",
        actorId: input.actorId,
        action: receiptAction,
        entityType: "approval",
        entityId: input.approvalId,
        agentId: input.agentId,
        runId: input.runId,
        details: {
          type: "outbound_tool_draft",
          ok: receiptAction === "approval.executed",
          outcome,
          recoveredByReconciliation: true,
          outcomeUncertain,
        },
      });
      repaired = inserted !== false;
      receipt = { action: receiptAction, details: { outcome, outcomeUncertain } };
    }

    const policySource = input.details?.policySource ?? input.details?.actionPolicySource;
    if (!input.actionActorId || typeof policySource !== "string" || storedOutcome) return repaired;

    const recoveredAction = receipt.action === "approval.executed"
      ? "agent_action.allowed"
      : receipt.details?.outcome === "refused"
        ? "agent_action.refused"
        : "agent_action.failed";
    const outcomeUncertain = receipt.details?.outcomeUncertain === true;
    const inserted = await logActivity(db, {
      id: outcomeId,
      companyId: input.companyId,
      actorType: "agent",
      actorId: input.actionActorId,
      action: recoveredAction,
      entityType: "approval",
      entityId: input.approvalId,
      agentId: input.agentId,
      runId: input.runId,
      details: {
        actionType: input.details?.actionType ?? null,
        tool: input.details?.tool ?? input.details?.toolName ?? null,
        policySource,
        approvalId: input.approvalId,
        ...(input.executionAttemptId ? { executionAttemptId: input.executionAttemptId } : {}),
        ...(recoveredAction === "agent_action.failed"
          ? {
              error: outcomeUncertain
                ? "The action execution ended without a durable success receipt."
                : "Approval processing stopped before the action began, so it was not run.",
            }
          : {}),
        outcomeUncertain,
        recoveredByReconciliation: true,
      },
    });
    return inserted !== false || repaired;
  }

  return {
    reconcileStaleExecutions: async (now = new Date()) => {
      const staleBefore = new Date(now.getTime() - 10 * 60_000);
      let scanned = 0;
      let reconciled = 0;

      while (true) {
        const staleStarts = await db
          .select({
            id: activityLog.id,
            action: activityLog.action,
            companyId: activityLog.companyId,
            actorId: activityLog.actorId,
            entityType: activityLog.entityType,
            entityId: activityLog.entityId,
            agentId: activityLog.agentId,
            runId: activityLog.runId,
            details: activityLog.details,
          })
          .from(activityLog)
          .where(and(
            inArray(activityLog.action, [
              "agent_action.execution_started",
              "approval.execution_started",
            ]),
            lte(activityLog.createdAt, staleBefore),
            sql`(
              (
                ${activityLog.action} = 'agent_action.execution_started'
                AND NOT EXISTS (
                  SELECT 1
                  FROM "activity_log" AS "terminal_direct"
                  WHERE "terminal_direct"."company_id" = ${activityLog.companyId}
                    AND "terminal_direct"."action" IN ('agent_action.allowed', 'agent_action.failed', 'agent_action.refused')
                    AND "terminal_direct"."details" ->> 'executionAttemptId' = ${activityLog.id}::text
                )
              )
              OR
              (
                ${activityLog.action} = 'approval.execution_started'
                AND (
                  NOT EXISTS (
                    SELECT 1
                    FROM "activity_log" AS "approval_receipt"
                    WHERE "approval_receipt"."company_id" = ${activityLog.companyId}
                      AND "approval_receipt"."entity_type" = 'approval'
                      AND "approval_receipt"."entity_id" = ${activityLog.entityId}
                      AND "approval_receipt"."action" IN ('approval.executed', 'approval.execute_failed')
                  )
                  OR (
                    (
                      ${activityLog.agentId} IS NOT NULL
                      OR ${activityLog.details} ->> 'actionActorId' IS NOT NULL
                    )
                    AND ${activityLog.details} ->> 'policySource' IS NOT NULL
                    AND NOT EXISTS (
                      SELECT 1
                      FROM "activity_log" AS "approval_outcome"
                      WHERE "approval_outcome"."company_id" = ${activityLog.companyId}
                        AND "approval_outcome"."entity_type" = 'approval'
                        AND "approval_outcome"."entity_id" = ${activityLog.entityId}
                        AND "approval_outcome"."action" IN ('agent_action.allowed', 'agent_action.failed', 'agent_action.refused')
                    )
                  )
                )
              )
            )`,
          ))
          .orderBy(asc(activityLog.createdAt), asc(activityLog.id))
          .limit(500);
        scanned += staleStarts.length;

        for (const start of staleStarts) {
          if (start.action === "approval.execution_started") {
            const repaired = await reconcileApprovalAudit({
              companyId: start.companyId,
              approvalId: start.entityId,
              actorId: start.actorId,
              agentId: start.agentId,
              actionActorId: start.agentId ??
                (typeof start.details?.actionActorId === "string"
                  ? start.details.actionActorId
                  : null),
              runId: start.runId,
              details: start.details,
              executionAttemptId: start.id,
              missingOutcomeUncertain: true,
            });
            if (repaired) reconciled += 1;
            continue;
          }

          const outcomeId = deterministicActivityId("agent-action-execution-outcome", start.id);
          const inserted = await logActivity(db, {
            id: outcomeId,
            companyId: start.companyId,
            actorType: "agent",
            actorId: start.actorId,
            action: "agent_action.failed",
            entityType: start.entityType,
            entityId: start.entityId,
            agentId: start.agentId,
            runId: start.runId,
            details: {
              ...(start.details ?? {}),
              executionAttemptId: start.id,
              error: "The action execution ended without a durable success receipt.",
              outcomeUncertain: true,
              recoveredByReconciliation: true,
            },
          });
          if (inserted !== false) reconciled += 1;
        }
        if (staleStarts.length < 500) break;
      }

      while (true) {
        const abandonedApprovals = await db
          .select({
            id: approvals.id,
            companyId: approvals.companyId,
            decidedByUserId: approvals.decidedByUserId,
            requestedByAgentId: approvals.requestedByAgentId,
            payload: approvals.payload,
          })
          .from(approvals)
          .where(and(
            eq(approvals.status, "approved"),
            eq(approvals.type, "outbound_tool_draft"),
            lte(approvals.decidedAt, staleBefore),
            sql`NOT EXISTS (
              SELECT 1
              FROM "activity_log" AS "approval_start"
              WHERE "approval_start"."company_id" = ${approvals.companyId}
                AND "approval_start"."entity_type" = 'approval'
                AND "approval_start"."entity_id" = ${approvals.id}::text
                AND "approval_start"."action" = 'approval.execution_started'
            )`,
            sql`(
              NOT EXISTS (
                SELECT 1
                FROM "activity_log" AS "orphan_receipt"
                WHERE "orphan_receipt"."company_id" = ${approvals.companyId}
                  AND "orphan_receipt"."entity_type" = 'approval'
                  AND "orphan_receipt"."entity_id" = ${approvals.id}::text
                  AND "orphan_receipt"."action" IN ('approval.executed', 'approval.execute_failed')
              )
              OR (
                (
                  ${approvals.requestedByAgentId} IS NOT NULL
                  OR ${approvals.payload} ->> 'agentId' IS NOT NULL
                )
                AND ${approvals.payload} ->> 'actionPolicySource' IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1
                  FROM "activity_log" AS "orphan_outcome"
                  WHERE "orphan_outcome"."company_id" = ${approvals.companyId}
                    AND "orphan_outcome"."entity_type" = 'approval'
                    AND "orphan_outcome"."entity_id" = ${approvals.id}::text
                    AND "orphan_outcome"."action" IN ('agent_action.allowed', 'agent_action.failed', 'agent_action.refused')
                )
              )
            )`,
          ))
          .orderBy(asc(approvals.decidedAt), asc(approvals.id))
          .limit(500);
        scanned += abandonedApprovals.length;

        for (const approval of abandonedApprovals) {
          const runId = await durableRunId(
            db,
            approval.payload.runId,
            approval.companyId,
            approval.requestedByAgentId,
          );
          const repaired = await reconcileApprovalAudit({
            companyId: approval.companyId,
            approvalId: approval.id,
            actorId: approval.decidedByUserId ?? REVIEW_ACTOR_ID,
            agentId: approval.requestedByAgentId,
            actionActorId: approval.requestedByAgentId ??
              (typeof approval.payload.agentId === "string" ? approval.payload.agentId : null),
            runId,
            details: approval.payload,
            missingOutcomeUncertain: false,
          });
          if (repaired) reconciled += 1;
        }
        if (abandonedApprovals.length < 500) break;
      }

      while (true) {
        const abandonedRejections = await db
          .select({
            id: approvals.id,
            companyId: approvals.companyId,
            decidedByUserId: approvals.decidedByUserId,
            requestedByAgentId: approvals.requestedByAgentId,
            payload: approvals.payload,
          })
          .from(approvals)
          .where(and(
            eq(approvals.status, "rejected"),
            eq(approvals.type, "outbound_tool_draft"),
            lte(approvals.decidedAt, staleBefore),
            sql`(
              ${approvals.requestedByAgentId} IS NOT NULL
              OR ${approvals.payload} ->> 'agentId' IS NOT NULL
            )`,
            sql`${approvals.payload} ->> 'actionPolicySource' IS NOT NULL`,
            sql`NOT EXISTS (
              SELECT 1
              FROM "activity_log" AS "rejection_outcome"
              WHERE "rejection_outcome"."company_id" = ${approvals.companyId}
                AND "rejection_outcome"."entity_type" = 'approval'
                AND "rejection_outcome"."entity_id" = ${approvals.id}::text
                AND "rejection_outcome"."action" = 'agent_action.refused'
            )`,
          ))
          .orderBy(asc(approvals.decidedAt), asc(approvals.id))
          .limit(500);
        scanned += abandonedRejections.length;

        for (const approval of abandonedRejections) {
          const policySource = approval.payload.actionPolicySource;
          const actionActorId = approval.requestedByAgentId ??
            (typeof approval.payload.agentId === "string" ? approval.payload.agentId : null);
          if (!actionActorId || typeof policySource !== "string") continue;
          const runId = await durableRunId(
            db,
            approval.payload.runId,
            approval.companyId,
            approval.requestedByAgentId,
          );
          const inserted = await logActivity(db, {
            id: deterministicActivityId("agent-action-outcome", approval.id),
            companyId: approval.companyId,
            actorType: "agent",
            actorId: actionActorId,
            action: "agent_action.refused",
            entityType: "approval",
            entityId: approval.id,
            agentId: approval.requestedByAgentId,
            runId,
            details: {
              actionType: approval.payload.actionType ?? null,
              tool: approval.payload.toolName ?? null,
              policySource,
              approvalId: approval.id,
              decidedByUserId: approval.decidedByUserId,
              recoveredByReconciliation: true,
            },
          });
          if (inserted !== false) reconciled += 1;
        }
        if (abandonedRejections.length < 500) break;
      }

      while (true) {
        const unauditedPending = await db
          .select({
            id: approvals.id,
            companyId: approvals.companyId,
            requestedByAgentId: approvals.requestedByAgentId,
            payload: approvals.payload,
          })
          .from(approvals)
          .where(and(
            eq(approvals.status, "pending"),
            eq(approvals.type, "outbound_tool_draft"),
            lte(approvals.createdAt, staleBefore),
            sql`(
              ${approvals.requestedByAgentId} IS NOT NULL
              OR ${approvals.payload} ->> 'agentId' IS NOT NULL
            )`,
            sql`${approvals.payload} ->> 'actionPolicySource' IS NOT NULL`,
            sql`NOT EXISTS (
              SELECT 1
              FROM "activity_log" AS "approval_request_audit"
              WHERE "approval_request_audit"."company_id" = ${approvals.companyId}
                AND "approval_request_audit"."entity_type" = 'approval'
                AND "approval_request_audit"."entity_id" = ${approvals.id}::text
                AND "approval_request_audit"."action" = 'agent_action.approval_requested'
            )`,
          ))
          .orderBy(asc(approvals.createdAt), asc(approvals.id))
          .limit(500);
        scanned += unauditedPending.length;

        for (const approval of unauditedPending) {
          const policySource = approval.payload.actionPolicySource;
          const actionActorId = approval.requestedByAgentId ??
            (typeof approval.payload.agentId === "string" ? approval.payload.agentId : null);
          if (!actionActorId || typeof policySource !== "string") continue;
          const runId = await durableRunId(
            db,
            approval.payload.runId,
            approval.companyId,
            approval.requestedByAgentId,
          );
          const inserted = await logActivity(db, {
            id: deterministicActivityId("agent-action-approval-requested", approval.id),
            companyId: approval.companyId,
            actorType: "agent",
            actorId: actionActorId,
            action: "agent_action.approval_requested",
            entityType: "approval",
            entityId: approval.id,
            agentId: approval.requestedByAgentId,
            runId,
            details: {
              actionType: approval.payload.actionType ?? null,
              tool: approval.payload.toolName ?? null,
              policySource,
              summary: approval.payload.summary ?? null,
              recoveredByReconciliation: true,
            },
          });
          if (inserted !== false) reconciled += 1;
        }
        if (unauditedPending.length < 500) break;
      }

      return { scanned, reconciled };
    },

    runDailyReview: async (now = new Date()) => {
      const { day, start } = reviewDayFor(now);
      const activeCompanies = await db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.status, "active"));
      let findingCount = 0;
      let flagged = 0;

      for (const company of activeCompanies) {
        const [companyFindings, existingRows] = await Promise.all([
          findings.detectBroadAgentActionPermissions(company.id),
          db
            .select({ details: activityLog.details })
            .from(activityLog)
            .where(and(
              eq(activityLog.companyId, company.id),
              eq(activityLog.action, REVIEW_ACTION),
              gte(activityLog.createdAt, start),
            )),
        ]);
        findingCount += companyFindings.length;
        const recorded = new Set(
          existingRows.flatMap((row) => {
            const value = row.details?.findingFingerprint;
            return typeof value === "string" ? [value] : [];
          }),
        );

        for (const finding of companyFindings) {
          if (recorded.has(finding.fingerprint)) continue;
          await logActivity(db, {
            id: deterministicActivityId(
              REVIEW_ACTION,
              day,
              company.id,
              finding.fingerprint,
            ),
            companyId: company.id,
            actorType: "system",
            actorId: REVIEW_ACTOR_ID,
            action: REVIEW_ACTION,
            entityType: finding.subjectType,
            entityId: finding.subjectId,
            agentId: finding.subjectType === "agent" ? finding.subjectId : null,
            details: {
              ...finding.details,
              findingKind: finding.kind,
              findingFingerprint: finding.fingerprint,
              severity: finding.severity,
              summary: finding.summary,
              reviewDay: day,
            },
          });
          recorded.add(finding.fingerprint);
          flagged += 1;
        }
      }

      return {
        reviewDay: day,
        companiesScanned: activeCompanies.length,
        findings: findingCount,
        flagged,
      };
    },
  };
}

export type AgentActionPermissionReviewService = ReturnType<typeof agentActionPermissionReviewService>;
