import type { Db } from "@paperclipai/db";
import { approvals, companies, issueComments, issues } from "@paperclipai/db";
import { instructionChangePayloadSchema } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import { notFound, unprocessable } from "../errors.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { instanceSettingsService } from "./instance-settings.js";
import {
  persistActivityLog,
  publishPersistedActivityLog,
} from "./activity-log.js";

/** Commit the decision, audit record and source receipt together. */
export async function rejectInstructionRule(
  db: Db,
  approvalId: string,
  decidedByUserId: string,
  decisionNote?: string | null,
  activityDetails: Record<string, unknown> = {},
  activityRecorder: typeof persistActivityLog = persistActivityLog,
) {
  const result = await db.transaction(async (tx) => {
    const approvalCompany = await tx
      .select({ companyId: approvals.companyId })
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .then((rows) => rows[0] ?? null);
    if (!approvalCompany) throw notFound("Approval not found");

    // Use the same lock order as instruction approval and resubmission.
    await tx.select({ id: companies.id }).from(companies)
      .where(eq(companies.id, approvalCompany.companyId)).for("update");
    const existing = await tx.select().from(approvals)
      .where(eq(approvals.id, approvalId)).for("update")
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("Approval not found");
    if (existing.type !== "instruction_change") {
      throw unprocessable("Approval is not an instruction change");
    }
    if (existing.status === "rejected") {
      return { approval: existing, applied: false, activity: null };
    }
    if (!["pending", "revision_requested"].includes(existing.status)) {
      throw unprocessable("Only pending or revision requested approvals can be rejected");
    }

    const payload = instructionChangePayloadSchema.parse(existing.payload);
    const sourceIssue = await tx.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.id, payload.sourceIssueId), eq(issues.companyId, existing.companyId)))
      .for("update").then((rows) => rows[0] ?? null);

    const now = new Date();
    const approval = await tx.update(approvals).set({
      status: "rejected",
      decidedByUserId,
      decisionNote: decisionNote ?? null,
      decidedAt: now,
      updatedAt: now,
    }).where(eq(approvals.id, approvalId)).returning().then((rows) => rows[0]!);
    const activity = await activityRecorder(tx as unknown as Db, {
      companyId: approval.companyId,
      actorType: "user",
      actorId: decidedByUserId,
      action: "approval.rejected",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type, ...activityDetails },
    });
    // Removing source evidence blocks approval, but must not block rejection.
    // When the issue still exists, its receipt is part of this transaction.
    if (sourceIssue) {
      const note = approval.decisionNote?.trim();
      const body = note ? `Standing rule rejected: ${note}` : "Standing rule rejected by the board.";
      const { censorUsernameInLogs } = await instanceSettingsService(tx as unknown as Db).getGeneral();
      await tx.insert(issueComments).values({
        companyId: approval.companyId,
        issueId: sourceIssue.id,
        authorType: "system",
        intent: "message",
        body: redactCurrentUserText(body, { enabled: censorUsernameInLogs }),
      });
      await tx.update(issues).set({ updatedAt: now }).where(eq(issues.id, sourceIssue.id));
    }
    return { approval, applied: true, activity };
  });
  if (result.activity) publishPersistedActivityLog(result.activity);
  return { approval: result.approval, applied: result.applied };
}
