/**
 * Approval decisions: approve or reject, with everything that follows.
 *
 * One implementation for every caller. The web app's approval routes call it,
 * and so does the plugin host method `approvals.respond`, so a decision made
 * from Slack does exactly what a click in the Approvals page does: record the
 * decision, re-dispatch a drafted outbound tool call, log what happened, note
 * the outcome on the linked issue, resume the chat session that drafted it,
 * and wake the agent that asked.
 *
 * Access is the caller's job: the route checks the request actor, and the
 * plugin host method applies that same check to the user paired to the chat
 * account that pressed the button.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { activityLog, heartbeatRuns, type Db } from "@paperclipai/db";
import { instructionChangePayloadSchema, isUuidLike } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import {
  approvalService,
  heartbeatService,
  issueApprovalService,
  issueService,
  logActivity,
} from "./index.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import type { PluginToolDispatcher } from "./plugin-tool-dispatcher.js";
import { executeDraftedApproval, isAgentActionRefusalReason } from "./tool-draft-gate.js";
import { appendApprovedDraftResultToChatSession } from "./chat.js";
import { serviceUnavailable } from "../errors.js";
import { deterministicActivityId } from "./activity-log.js";

// Brokered tool RPCs have a five-minute hard limit. A durable lease lets any
// server process distinguish a live execution from an interrupted one while
// leaving enough margin for the receipt writes after the tool returns.
const ACTION_EXECUTION_LEASE_MS = 10 * 60_000;

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

export interface ApprovalDecisionDeps {
  pluginWorkerManager?: PluginWorkerManager;
  /** An existing heartbeat service to wake requesters with; one is built when absent. */
  heartbeat?: Pick<ReturnType<typeof heartbeatService>, "wakeup">;
  /**
   * Lazy reference to the tool dispatcher, used to re-dispatch
   * `outbound_tool_draft` approvals once approved. Lazy because the dispatcher
   * is constructed after the routes are mounted.
   */
  getToolDispatcher?: () => PluginToolDispatcher | null;
  /** Test seam for looking up a durable action outcome during an idempotent retry. */
  findActionAudit?: (
    companyId: string,
    approvalId: string,
  ) => Promise<Array<{ action: string; details: Record<string, unknown> | null }>>;
}

export interface DraftExecutionOutcome {
  ok: boolean;
  reason: string | null;
  error: string | null;
  outcome: "allowed" | "refused" | "failed";
}

export interface ApprovalDecisionInput {
  approvalId: string;
  decidedByUserId: string;
  decisionNote?: string | null;
  /**
   * Set when the decision came through a plugin (a Slack button, for
   * example) rather than the web app, so the activity log says so.
   */
  via?: { pluginId: string; pluginKey: string } | null;
}

/** The approval row as the approval service returns it after a decision. */
export type DecidedApproval = Awaited<ReturnType<ReturnType<typeof approvalService>["approve"]>>["approval"];

export interface ApprovalDecisionResult {
  approval: DecidedApproval;
  /** False when already decided; instruction decision wakeups may still retry. */
  applied: boolean;
  /** What happened to a drafted outbound call on approve; null otherwise. */
  draftExecution: DraftExecutionOutcome | null;
}

/**
 * Activity details for a decision that came through a plugin, in the field
 * names PLUGIN_SPEC uses for plugin-originated work. The actor stays the user,
 * who made the decision; these say where they made it.
 */
function pluginSourceDetails(input: ApprovalDecisionInput): Record<string, string> {
  return input.via ? { sourcePluginId: input.via.pluginId, sourcePluginKey: input.via.pluginKey } : {};
}

export function approvalDecisionService(db: Db, deps: ApprovalDecisionDeps = {}) {
  const svc = approvalService(db);
  const heartbeat = deps.heartbeat ?? heartbeatService(db, { pluginWorkerManager: deps.pluginWorkerManager });
  const issueApprovalsSvc = issueApprovalService(db);
  const issuesSvc = issueService(db);
  const activeActionExecutions = new Set<string>();

  async function findActionAudit(companyId: string, approvalId: string) {
    if (deps.findActionAudit) return deps.findActionAudit(companyId, approvalId);
    return db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.entityType, "approval"),
        eq(activityLog.entityId, approvalId),
        inArray(activityLog.action, [
          "agent_action.allowed",
          "agent_action.failed",
          "agent_action.refused",
          "approval.execution_started",
          "approval.executed",
          "approval.execute_failed",
          "approval.rejected",
        ]),
      ))
      .orderBy(desc(activityLog.createdAt))
      .limit(10);
  }

  async function repairApprovedActionAudit(approval: DecidedApproval, decidedByUserId: string) {
    if (approval.type !== "outbound_tool_draft") return;
    const payload = (approval.payload ?? {}) as Record<string, unknown>;
    const actionActorId = approval.requestedByAgentId ??
      (typeof payload.agentId === "string" ? payload.agentId : null);
    if (!actionActorId) return;
    const runId = await durableRunId(
      db,
      payload.runId,
      approval.companyId,
      approval.requestedByAgentId,
    );
    const policySource = typeof payload.actionPolicySource === "string" ? payload.actionPolicySource : null;
    if (!policySource) return;
    const prior = await findActionAudit(approval.companyId, approval.id);
    const terminalAction = prior.find((row) =>
      row.action === "agent_action.allowed" ||
      row.action === "agent_action.failed" ||
      row.action === "agent_action.refused"
    );
    let execution = prior.find(
      (row) => row.action === "approval.executed" || row.action === "approval.execute_failed",
    );
    if (terminalAction && !execution) {
      const action = terminalAction.action === "agent_action.allowed"
        ? "approval.executed"
        : "approval.execute_failed";
      const outcome = terminalAction.action === "agent_action.allowed"
        ? "allowed"
        : terminalAction.action === "agent_action.refused"
          ? "refused"
          : "failed";
      await logActivity(db, {
        id: deterministicActivityId("approval-execution-receipt", approval.id),
        companyId: approval.companyId,
        actorType: "user",
        actorId: approval.decidedByUserId ?? decidedByUserId,
        action,
        entityType: "approval",
        entityId: approval.id,
        details: {
          type: approval.type,
          ok: action === "approval.executed",
          outcome,
          recoveredOnRetry: true,
        },
      });
      execution = { action, details: { outcome } };
    }
    if (terminalAction) return;
    if (activeActionExecutions.has(approval.id)) return;
    const executionStart = prior.find((row) => row.action === "approval.execution_started");
    const decisionTime = new Date(approval.decidedAt ?? approval.updatedAt).getTime();
    if (
      !execution &&
      !executionStart &&
      Number.isFinite(decisionTime) &&
      Date.now() - decisionTime < ACTION_EXECUTION_LEASE_MS
    ) {
      return;
    }
    const leaseExpiresAt = executionStart?.details?.leaseExpiresAt;
    if (
      !execution &&
      typeof leaseExpiresAt === "string" &&
      new Date(leaseExpiresAt).getTime() > Date.now()
    ) {
      return;
    }
    const allowed = execution?.action === "approval.executed";
    const refused = execution?.details?.outcome === "refused";
    const outcomeUncertain = !execution && Boolean(executionStart);
    await logActivity(db, {
      id: deterministicActivityId("agent-action-outcome", approval.id),
      companyId: approval.companyId,
      actorType: "agent",
      actorId: actionActorId,
      action: allowed
        ? "agent_action.allowed"
        : refused
          ? "agent_action.refused"
          : "agent_action.failed",
      entityType: "approval",
      entityId: approval.id,
      agentId: approval.requestedByAgentId,
      runId,
      details: {
        actionType: typeof payload.actionType === "string" ? payload.actionType : null,
        tool: payload.toolName ?? null,
        policySource,
        approvalId: approval.id,
        decidedByUserId: approval.decidedByUserId ?? decidedByUserId,
        recoveredOnRetry: true,
        ...(!allowed ? {
          error: execution
            ? "The approved action did not complete."
            : outcomeUncertain
              ? "Approval processing was interrupted, so the action outcome is unknown and it was not run again."
              : "Approval processing stopped before the action began, so it was not run.",
          outcomeUncertain,
        } : {}),
      },
    });
  }

  async function repairRejectedActionAudit(approval: DecidedApproval, decidedByUserId: string) {
    if (approval.type !== "outbound_tool_draft") return;
    const payload = (approval.payload ?? {}) as Record<string, unknown>;
    const actionActorId = approval.requestedByAgentId ??
      (typeof payload.agentId === "string" ? payload.agentId : null);
    if (!actionActorId) return;
    const runId = await durableRunId(
      db,
      payload.runId,
      approval.companyId,
      approval.requestedByAgentId,
    );
    const policySource = typeof payload.actionPolicySource === "string" ? payload.actionPolicySource : null;
    if (!policySource) return;
    const prior = await findActionAudit(approval.companyId, approval.id);
    if (prior.some((row) => row.action === "agent_action.refused")) return;
    await logActivity(db, {
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
        actionType: typeof payload.actionType === "string" ? payload.actionType : null,
        tool: payload.toolName ?? null,
        policySource,
        approvalId: approval.id,
        decidedByUserId: approval.decidedByUserId ?? decidedByUserId,
        recoveredOnRetry: true,
      },
    });
  }

  async function approve(input: ApprovalDecisionInput): Promise<ApprovalDecisionResult> {
    const decidedByUserId = input.decidedByUserId;
    const pluginSource = pluginSourceDetails(input);
    const { approval, applied } = await svc.approve(
      input.approvalId,
      decidedByUserId,
      input.decisionNote ?? undefined,
      pluginSource,
    );
    let draftExecution: DraftExecutionOutcome | null = null;

    if (applied || (approval.type === "instruction_change" && approval.status === "approved")) {
      const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id).catch((err) => {
        logger.warn({ err, approvalId: approval.id }, "failed to read linked issues after approval");
        return [];
      });
      const linkedIssueIds = linkedIssues.map((issue) => issue.id);
      const primaryIssueId = linkedIssueIds[0] ?? null;

      if (applied && approval.type !== "instruction_change") {
        await logActivity(db, {
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
            ...pluginSource,
          },
        }).catch((err) => {
          logger.warn({ err, approvalId: approval.id }, "failed to record approval decision activity");
        });
      }

      // Trust loop: if this was a drafted outbound tool call, re-dispatch
      // it now that the user has approved. The re-dispatch must pass
      // `bypassDraftGate: true`, otherwise the dispatcher's gate will
      // re-intercept the gated tool name and queue a fresh pending approval:
      // the user would approve, a new pending appears, approve, repeat.
      // Log a separate "approval.executed" activity so the receipt feed
      // shows both the draft (created on the agent's call) and the actual send.
      // What actually happened to the drafted call, so the wake below can say
      // so. Without it the agent is woken knowing only that its draft was
      // "approved", which is not the same as "sent". One agent read that gap
      // as the send still being pending and spent four more runs, and a
      // second Slack draft, telling the operator about a message that had
      // already gone out four minutes earlier.
      if (approval.type === "outbound_tool_draft") {
        activeActionExecutions.add(approval.id);
        try {
          const leaseExpiresAt = new Date(Date.now() + ACTION_EXECUTION_LEASE_MS).toISOString();
          const actionPayload = (approval.payload ?? {}) as Record<string, unknown>;
          const actionActorId = approval.requestedByAgentId ??
            (typeof actionPayload.agentId === "string" ? actionPayload.agentId : null);
          const actionRunId = await durableRunId(
            db,
            actionPayload.runId,
            approval.companyId,
            approval.requestedByAgentId,
          );
          try {
            await logActivity(db, {
              id: deterministicActivityId("approval-execution-start", approval.id),
              companyId: approval.companyId,
              actorType: "user",
              actorId: decidedByUserId,
              action: "approval.execution_started",
              entityType: "approval",
              entityId: approval.id,
              agentId: approval.requestedByAgentId,
              runId: actionRunId,
              details: {
                type: approval.type,
                leaseExpiresAt,
                executionKind: "approval",
                approvalId: approval.id,
                requestedByAgentId: approval.requestedByAgentId,
                actionActorId,
                actionType: typeof actionPayload.actionType === "string" ? actionPayload.actionType : null,
                policySource: typeof actionPayload.actionPolicySource === "string"
                  ? actionPayload.actionPolicySource
                  : null,
                tool: actionPayload.toolName ?? null,
                ...pluginSource,
              },
            });
          } catch (err) {
            logger.error({ err, approvalId: approval.id }, "failed to record approval execution start");
            throw serviceUnavailable(
              `The approved action execution for "${approval.id}" could not be recorded, so the action was not run.`,
              { approvalId: approval.id, code: "ACTION_AUDIT_FAILED" },
            );
          }

          const dispatcher = deps.getToolDispatcher?.() ?? null;
          if (dispatcher) {
            const exec = await executeDraftedApproval({
              approvalId: approval.id,
              decidedByUserId,
              executeTool: (toolName, params, runContext) =>
                dispatcher.executeTool(toolName, params, runContext, {
                  bypassDraftGate: true,
                  approvedDraftConfirmation: true,
                }),
              db,
            });
            draftExecution = {
              ok: exec.ok && !exec.toolResult?.error,
              reason: exec.reason ?? null,
              error: exec.toolResult?.error ?? null,
              outcome: exec.ok && !exec.toolResult?.error
                ? "allowed"
                : exec.outcome ?? (isAgentActionRefusalReason(exec.toolResult?.error) ? "refused" : "failed"),
            };
            await logActivity(db, {
              id: deterministicActivityId("approval-execution-receipt", approval.id),
              companyId: approval.companyId,
              actorType: "user",
              actorId: decidedByUserId,
              action: draftExecution.ok ? "approval.executed" : "approval.execute_failed",
              entityType: "approval",
              entityId: approval.id,
              details: {
                type: approval.type,
                ok: draftExecution.ok,
                outcome: draftExecution.outcome,
                reason: exec.reason ?? null,
                hadError: !!exec.toolResult?.error,
                ...pluginSource,
              },
            }).catch((err) => {
              logger.warn({ err, approvalId: approval.id }, "failed to record approval execution receipt");
            });
            // Chat-session wake: if the draft was queued from a Clippy chat
            // turn, append a follow-up message into the transcript so the LLM
            // sees the resolved outcome on the user's next turn. Real agent
            // runs are woken via the heartbeat branch below; chat sessions
            // have no heartbeat, so this append is their only resume signal.
            const payload = (approval.payload ?? {}) as Record<string, unknown>;
            const chatSessionId =
              typeof payload.chatSessionId === "string" ? payload.chatSessionId : null;
            if (chatSessionId) {
              const toolName =
                typeof payload.toolName === "string" ? payload.toolName : "tool";
              const summary =
                typeof payload.summary === "string" ? payload.summary : toolName;
              const outcome: Parameters<typeof appendApprovedDraftResultToChatSession>[1]["outcome"] =
                !exec.ok
                  ? { ok: false, error: exec.reason ?? "execution_failed" }
                  : exec.toolResult?.error
                    ? { ok: false, error: exec.toolResult.error }
                    : {
                        ok: true,
                        content:
                          typeof exec.toolResult?.content === "string"
                            ? exec.toolResult.content
                            : exec.toolResult?.data !== undefined
                              ? JSON.stringify(exec.toolResult.data)
                              : null,
                      };
              try {
                const result = await appendApprovedDraftResultToChatSession(db, {
                  chatSessionId,
                  toolName,
                  summary,
                  outcome,
                });
                if ("skipped" in result) {
                  logger.warn(
                    { approvalId: approval.id, chatSessionId, reason: result.skipped },
                    "chat-session wake skipped: chat session no longer exists",
                  );
                }
              } catch (err) {
                // Don't fail the approve response if the chat append fails;
                // the underlying tool already ran. Log and move on.
                logger.warn(
                  { err, approvalId: approval.id, chatSessionId },
                  "chat-session wake append failed (non-fatal)",
                );
              }
            }
          } else {
            draftExecution = {
              ok: false,
              reason: "no_tool_dispatcher",
              error: "Plugin tools were not available, so the approved call did not run.",
              outcome: "failed",
            };
            await logActivity(db, {
              id: deterministicActivityId("approval-execution-receipt", approval.id),
              companyId: approval.companyId,
              actorType: "user",
              actorId: decidedByUserId,
              action: "approval.execute_failed",
              entityType: "approval",
              entityId: approval.id,
              details: {
                type: approval.type,
                ok: false,
                outcome: draftExecution.outcome,
                reason: draftExecution.reason,
                hadError: true,
                ...pluginSource,
              },
            });
            logger.warn({ approvalId: approval.id }, "outbound_tool_draft approved but no dispatcher available");
          }

          const actionType = typeof actionPayload.actionType === "string" ? actionPayload.actionType : null;
          const actionPolicySource = typeof actionPayload.actionPolicySource === "string"
            ? actionPayload.actionPolicySource
            : null;
          if (draftExecution && actionActorId && actionPolicySource) {
            try {
              await logActivity(db, {
                id: deterministicActivityId("agent-action-outcome", approval.id),
                companyId: approval.companyId,
                actorType: "agent",
                actorId: actionActorId,
                action: draftExecution.outcome === "allowed"
                  ? "agent_action.allowed"
                  : draftExecution.outcome === "refused"
                    ? "agent_action.refused"
                    : "agent_action.failed",
                entityType: "approval",
                entityId: approval.id,
                agentId: approval.requestedByAgentId,
                runId: actionRunId,
                details: {
                  actionType,
                  tool: actionPayload.toolName ?? null,
                  policySource: actionPolicySource,
                  approvalId: approval.id,
                  decidedByUserId,
                  ...(!draftExecution.ok
                    ? { error: draftExecution.error ?? draftExecution.reason ?? "execution_failed" }
                    : {}),
                },
              });
            } catch (err) {
              logger.error({ err, approvalId: approval.id }, "failed to record approved agent action outcome");
              throw serviceUnavailable(
                `The approved action outcome for "${approval.id}" could not be recorded. The action may have completed; do not retry it automatically.`,
                { approvalId: approval.id, code: "ACTION_AUDIT_FAILED" },
              );
            }
          }
        } finally {
          activeActionExecutions.delete(approval.id);
        }
      }

      // Say on the issue what happened to the message.
      //
      // Approving a draft used to leave no mark anywhere near the work: the
      // approval row moved to `approved`, the send succeeded, and the issue
      // the message was written for said nothing about either. The operator
      // is left unable to tell an approved-and-sent message from one that
      // silently failed, and the agent (which is only told its draft was
      // "approved") cannot tell either. A comment answers both, in the one
      // place both of them are already looking.
      if (draftExecution && primaryIssueId) {
        const payload = (approval.payload ?? {}) as Record<string, unknown>;
        const toolName = typeof payload.toolName === "string" ? payload.toolName : "the tool";
        const summary = typeof payload.summary === "string" ? payload.summary.trim() : "";
        const wentWrong = draftExecution.error ?? draftExecution.reason ?? null;
        const paragraphs = draftExecution.ok
          ? [`Sent. The approved \`${toolName}\` call went out just now.`, summary]
          : [
              `Not sent. The approved \`${toolName}\` call was approved but did not go out.`,
              wentWrong ? `What went wrong: ${wentWrong}` : null,
              "Nothing reached the recipient. It needs another try.",
            ];
        const body = paragraphs.filter((line): line is string => Boolean(line)).join("\n\n");
        try {
          await issuesSvc.addComment(primaryIssueId, body, {
            userId: decidedByUserId,
          });
        } catch (err) {
          // The message itself already went (or already failed). Losing the
          // note about it must not turn a successful send into a 500.
          logger.warn(
            { err, approvalId: approval.id, issueId: primaryIssueId },
            "could not comment the send outcome on the issue (non-fatal)",
          );
        }
      }

      if (approval.requestedByAgentId) {
        // The run that drafted the call. With no linked issue to wake the agent
        // about, the decision goes back to that run's conversation: woken in
        // any other, the agent no longer knows what it asked for, and has been
        // seen drafting the same message again (see tool-draft-gate.ts).
        const approvalPayload = (approval.payload ?? {}) as Record<string, unknown>;
        const draftRunId = typeof approvalPayload.runId === "string" ? approvalPayload.runId : null;
        try {
          const wakeRun = await heartbeat.wakeup(approval.requestedByAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "approval_approved",
            payload: {
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId: primaryIssueId,
              issueIds: linkedIssueIds,
              ...(draftExecution ? { draftExecution } : {}),
            },
            requestedByActorType: "user",
            requestedByActorId: decidedByUserId,
            idempotencyKey: approval.type === "instruction_change"
              ? `approval:${approval.id}:requester-wakeup:approved`
              : null,
            contextSnapshot: {
              source: "approval.approved",
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId: primaryIssueId,
              issueIds: linkedIssueIds,
              taskId: primaryIssueId,
              wakeReason: "approval_approved",
              ...(draftExecution ? { draftExecution } : {}),
            },
            continuesRunId: draftRunId,
          });

          await logActivity(db, {
            companyId: approval.companyId,
            actorType: "user",
            actorId: decidedByUserId,
            action: "approval.requester_wakeup_queued",
            entityType: "approval",
            entityId: approval.id,
            details: {
              requesterAgentId: approval.requestedByAgentId,
              wakeRunId: wakeRun?.id ?? null,
              linkedIssueIds,
            },
          });
        } catch (err) {
          logger.warn(
            {
              err,
              approvalId: approval.id,
              requestedByAgentId: approval.requestedByAgentId,
            },
            "failed to queue requester wakeup after approval",
          );
          await logActivity(db, {
            companyId: approval.companyId,
            actorType: "user",
            actorId: decidedByUserId,
            action: "approval.requester_wakeup_failed",
            entityType: "approval",
            entityId: approval.id,
            details: {
              requesterAgentId: approval.requestedByAgentId,
              linkedIssueIds,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }
    }

    if (!applied && approval.status === "approved") {
      try {
        await repairApprovedActionAudit(approval, decidedByUserId);
      } catch (err) {
        logger.error({ err, approvalId: approval.id }, "failed to repair approved agent action outcome");
        throw serviceUnavailable(
          `The approved action outcome for "${approval.id}" could not be recorded. The action was not run again.`,
          { approvalId: approval.id, code: "ACTION_AUDIT_FAILED" },
        );
      }
    }

    return { approval, applied, draftExecution };
  }

  async function reject(input: ApprovalDecisionInput): Promise<ApprovalDecisionResult> {
    const { approval, applied } = await svc.reject(
      input.approvalId,
      input.decidedByUserId,
      input.decisionNote ?? undefined,
      pluginSourceDetails(input),
    );

    if (applied && approval.type !== "instruction_change") {
      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: input.decidedByUserId,
        action: "approval.rejected",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type, ...pluginSourceDetails(input) },
      }).catch((err) => {
        logger.warn({ err, approvalId: approval.id }, "failed to record rejection decision activity");
      });
      const actionPayload = (approval.payload ?? {}) as Record<string, unknown>;
      const actionType = typeof actionPayload.actionType === "string" ? actionPayload.actionType : null;
      const actionPolicySource = typeof actionPayload.actionPolicySource === "string"
        ? actionPayload.actionPolicySource
        : null;
      const actionActorId = approval.requestedByAgentId ??
        (typeof actionPayload.agentId === "string" ? actionPayload.agentId : null);
      if (approval.type === "outbound_tool_draft" && actionActorId && actionPolicySource) {
        const actionRunId = await durableRunId(
          db,
          actionPayload.runId,
          approval.companyId,
          approval.requestedByAgentId,
        );
        try {
          await logActivity(db, {
            id: deterministicActivityId("agent-action-outcome", approval.id),
            companyId: approval.companyId,
            actorType: "agent",
            actorId: actionActorId,
            action: "agent_action.refused",
            entityType: "approval",
            entityId: approval.id,
            agentId: approval.requestedByAgentId,
            runId: actionRunId,
            details: {
              actionType,
              tool: actionPayload.toolName ?? null,
              policySource: actionPolicySource,
              approvalId: approval.id,
              decidedByUserId: input.decidedByUserId,
            },
          });
        } catch (err) {
          logger.error({ err, approvalId: approval.id }, "failed to record refused agent action outcome");
          throw serviceUnavailable(
            `The refused action outcome for "${approval.id}" could not be recorded. The approval decision was saved, but its audit record is missing.`,
            { approvalId: approval.id, code: "ACTION_AUDIT_FAILED" },
          );
        }
      }
    }
    if (!applied && approval.status === "rejected") {
      try {
        await repairRejectedActionAudit(approval, input.decidedByUserId);
      } catch (err) {
        logger.error({ err, approvalId: approval.id }, "failed to repair refused agent action outcome");
        throw serviceUnavailable(
          `The refused action outcome for "${approval.id}" could not be recorded. The approval decision was already saved.`,
          { approvalId: approval.id, code: "ACTION_AUDIT_FAILED" },
        );
      }
    }

    // Durable instruction rejection effects commit in the approval service.
    // Retry delivery after interruption, keeping one accepted wake request.
    if (approval.type === "instruction_change" && approval.status === "rejected") {
      const payload = instructionChangePayloadSchema.parse(approval.payload);
      if (approval.requestedByAgentId) {
        try {
          const sourceIssue = await issuesSvc.getById(payload.sourceIssueId);
          const issueId = sourceIssue?.companyId === approval.companyId ? sourceIssue.id : null;
          await heartbeat.wakeup(approval.requestedByAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "approval_rejected",
            payload: {
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId,
            },
            requestedByActorType: "user",
            requestedByActorId: approval.decidedByUserId ?? input.decidedByUserId,
            idempotencyKey: `approval:${approval.id}:requester-wakeup:rejected`,
            contextSnapshot: {
              source: "approval.rejected",
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId,
              taskId: issueId,
              wakeReason: "approval_rejected",
            },
          });
        } catch (err) {
          logger.warn({ err, approvalId: approval.id }, "failed to wake requester after instruction rule rejection");
        }
      }
    }

    return { approval, applied, draftExecution: null };
  }

  async function requestRevision(input: ApprovalDecisionInput): Promise<ApprovalDecisionResult> {
    const { approval, applied } = await svc.requestRevision(
      input.approvalId,
      input.decidedByUserId,
      input.decisionNote ?? undefined,
    );

    if (applied) {
      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: approval.decidedByUserId ?? input.decidedByUserId,
        action: "approval.revision_requested",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type },
      });
    }

    // Revision delivery is retried on every idempotent instruction-change
    // request. The heartbeat key ensures that a successful first delivery is
    // still accepted only once.
    if (
      approval.type === "instruction_change" &&
      approval.status === "revision_requested" &&
      approval.requestedByAgentId
    ) {
      const payload = instructionChangePayloadSchema.parse(approval.payload);
      try {
        const sourceIssue = await issuesSvc.getById(payload.sourceIssueId);
        const issueId = sourceIssue?.companyId === approval.companyId ? sourceIssue.id : null;
        const decisionNote = approval.decisionNote ?? null;
        const revisionCycle = new Date(approval.decidedAt ?? approval.updatedAt).toISOString();
        await heartbeat.wakeup(approval.requestedByAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "approval_revision_requested",
          payload: {
            approvalId: approval.id,
            approvalStatus: approval.status,
            decisionNote,
            revisionCycle,
            issueId,
            sourceIssueId: payload.sourceIssueId,
            sourceCommentId: payload.sourceCommentId,
            targetAgentId: payload.targetAgentId,
            scope: payload.scope,
            rule: payload.rule,
          },
          requestedByActorType: "user",
          requestedByActorId: approval.decidedByUserId ?? input.decidedByUserId,
          idempotencyKey: `approval:${approval.id}:requester-wakeup:revision-requested:${revisionCycle}`,
          contextSnapshot: {
            source: "approval.revision_requested",
            approvalId: approval.id,
            approvalStatus: approval.status,
            decisionNote,
            revisionCycle,
            issueId,
            taskId: issueId,
            sourceIssueId: payload.sourceIssueId,
            sourceCommentId: payload.sourceCommentId,
            targetAgentId: payload.targetAgentId,
            scope: payload.scope,
            rule: payload.rule,
            wakeReason: "approval_revision_requested",
          },
        });
      } catch (err) {
        logger.warn(
          { err, approvalId: approval.id },
          "failed to wake requester after instruction rule revision request",
        );
      }
    }

    return { approval, applied, draftExecution: null };
  }

  return { approve, reject, requestRevision };
}
