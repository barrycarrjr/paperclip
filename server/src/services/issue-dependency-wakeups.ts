import { createHash } from "node:crypto";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { agents, agentWakeupRequests, issueTerminalEvents, issues, type Db } from "@paperclipai/db";
import { issueService } from "./issues.js";
import { logger } from "../middleware/logger.js";

export type IssueDependencyWakeReason = "issue_children_completed" | "issue_blockers_resolved";

export async function buildIssueDependencyWakeup(
  db: Db, companyId: string, issueId: string, reason: IssueDependencyWakeReason,
) {
  const svc = issueService(db);
  const target = await db.select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId, status: issues.status })
    .from(issues).innerJoin(agents, and(eq(agents.id, issues.assigneeAgentId), eq(agents.companyId, companyId)))
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!target?.assigneeAgentId || ["backlog", "done", "cancelled"].includes(target.status)) return null;

  const parent = await svc.getWakeableParentAfterChildCompletion(issueId);
  const readiness = (await svc.listDependencyReadiness(companyId, [issueId])).get(issueId);
  const childIds = parent?.childIssueIds ?? [];
  const blockerIds = readiness?.blockerIssueIds ?? [];
  const sourceIds = [...new Set([...childIds, ...blockerIds])];
  let details: Record<string, unknown>;
  if (reason === "issue_children_completed") {
    if (!parent) return null;
    details = {
      childIssueIds: childIds,
      childIssueSummaries: parent.childIssueSummaries,
      childIssueSummaryTruncated: parent.childIssueSummaryTruncated,
    };
  } else {
    if (!readiness?.allBlockersDone || readiness.blockerIssueIds.length === 0) return null;
    details = { blockerIssueIds: blockerIds };
  }
  // Versions survive reopens, even when raw SQL does not maintain completedAt.
  // Scope every source as well as the assignee to prevent malformed links from
  // delivering another company's task titles or comments to this agent.
  const sources = await db.select({ id: issues.id, status: issues.status, version: issueTerminalEvents.version })
    .from(issues).leftJoin(issueTerminalEvents, and(
      eq(issueTerminalEvents.issueId, issues.id), eq(issueTerminalEvents.companyId, companyId),
    ))
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, sourceIds)))
    .orderBy(asc(issues.id));
  if (sources.length !== sourceIds.length || sources.some((source) => (
    (childIds.includes(source.id) && !["done", "cancelled"].includes(source.status)) ||
    (reason === "issue_blockers_resolved" && blockerIds.includes(source.id) && source.status !== "done")
  ))) return null;
  const fingerprint = createHash("sha256").update(JSON.stringify([
    companyId, issueId, target.assigneeAgentId, [...childIds].sort(), [...blockerIds].sort(),
    sources.map((source) => [source.id, source.status, source.version]),
  ])).digest("hex");
  const payload = { issueId, ...details };
  return {
    agentId: target.assigneeAgentId,
    options: {
      source: "automation" as const,
      triggerDetail: "system" as const,
      reason,
      idempotencyKey: `issue-dependency:${fingerprint}`,
      issueDependencyFingerprint: fingerprint,
      payload,
      requestedByActorType: "system" as const,
      requestedByActorId: "issue_dependency_reconciliation",
      contextSnapshot: { ...payload, taskId: issueId, wakeReason: reason, issueDependencyFingerprint: fingerprint, source: reason === "issue_children_completed" ? "issue.children_completed" : "issue.blockers_resolved" },
    },
  };
}

export function issueDependencyWakeupService(
  db: Db,
  enqueueWakeup: (agentId: string, options: NonNullable<Awaited<ReturnType<typeof buildIssueDependencyWakeup>>>["options"]) => Promise<unknown>,
) {
  return {
    async reconcile() {
      const pending = await db.select({
        issueId: issueTerminalEvents.issueId, companyId: issueTerminalEvents.companyId,
        version: issueTerminalEvents.version, status: issues.status, parentId: issues.parentId,
      }).from(issueTerminalEvents).innerJoin(issues, and(
        eq(issues.id, issueTerminalEvents.issueId), eq(issues.companyId, issueTerminalEvents.companyId),
      )).where(sql`${issueTerminalEvents.processedVersion} < ${issueTerminalEvents.version}`);
      let processed = 0;
      let retried = 0;
      // Many pending events (every closed child of one parent) resolve to the
      // same target and reason. Build and enqueue each target once per tick and
      // share the outcome, instead of once per event.
      const outcomes = new Map<string, Promise<boolean>>();
      const deliver = (companyId: string, issueId: string, reason: IssueDependencyWakeReason) => {
        const key = `${companyId}:${issueId}:${reason}`;
        let outcome = outcomes.get(key);
        if (!outcome) {
          outcome = (async () => {
            const wakeup = await buildIssueDependencyWakeup(db, companyId, issueId, reason);
            if (!wakeup) return true;
            await enqueueWakeup(wakeup.agentId, wakeup.options);
            // null can mean a successful deferral or a policy skip. Only a
            // persisted accepted request acknowledges delivery; skips retry.
            const receipt = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
              .where(and(
                eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, wakeup.agentId),
                eq(agentWakeupRequests.idempotencyKey, wakeup.options.idempotencyKey), ne(agentWakeupRequests.status, "skipped"),
              )).limit(1);
            return receipt.length > 0;
          })();
          outcomes.set(key, outcome);
        }
        return outcome;
      };
      for (const event of pending) {
        try {
          const targets = new Map<string, IssueDependencyWakeReason[]>();
          if (["done", "cancelled"].includes(event.status) && event.parentId) {
            targets.set(event.parentId, ["issue_children_completed"]);
          }
          if (event.status === "done") {
            const dependents = await issueService(db).listWakeableBlockedDependents(event.issueId);
            for (const dependent of dependents) {
              targets.set(dependent.id, [...(targets.get(dependent.id) ?? []), "issue_blockers_resolved"]);
            }
          }
          let accepted = true;
          for (const [issueId, reasons] of targets) {
            for (const reason of reasons) {
              if (!(await deliver(event.companyId, issueId, reason))) accepted = false;
            }
          }
          if (!accepted) { retried += 1; continue; }
          await db.update(issueTerminalEvents).set({ processedVersion: event.version }).where(and(
            eq(issueTerminalEvents.issueId, event.issueId), eq(issueTerminalEvents.companyId, event.companyId),
            eq(issueTerminalEvents.version, event.version),
            sql`${issueTerminalEvents.processedVersion} < ${event.version}`,
          ));
          processed += 1;
        } catch (err) {
          retried += 1;
          logger.warn({ err, issueId: event.issueId }, "issue dependency wake will retry on the next scheduler tick");
        }
      }
      return { processed, retried };
    },
  };
}
