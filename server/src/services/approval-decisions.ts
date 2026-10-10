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
import type { Db } from "@paperclipai/db";
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
import { executeDraftedApproval } from "./tool-draft-gate.js";
import { appendApprovedDraftResultToChatSession } from "./chat.js";

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
}

export interface DraftExecutionOutcome {
  ok: boolean;
  reason: string | null;
  error: string | null;
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
  /** False when the approval was already decided; nothing else happened. */
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

  async function approve(input: ApprovalDecisionInput): Promise<ApprovalDecisionResult> {
    const decidedByUserId = input.decidedByUserId;
    const pluginSource = pluginSourceDetails(input);
    const { approval, applied } = await svc.approve(input.approvalId, decidedByUserId, input.decisionNote ?? undefined);
    let draftExecution: DraftExecutionOutcome | null = null;

    if (applied) {
      const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
      const linkedIssueIds = linkedIssues.map((issue) => issue.id);
      const primaryIssueId = linkedIssueIds[0] ?? null;

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
      });

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
        const dispatcher = deps.getToolDispatcher?.() ?? null;
        if (dispatcher) {
          const exec = await executeDraftedApproval({
            approvalId: approval.id,
            decidedByUserId,
            executeTool: (toolName, params, runContext) =>
              dispatcher.executeTool(toolName, params, runContext, {
                bypassDraftGate: true,
              }),
            db,
          });
          draftExecution = {
            ok: exec.ok && !exec.toolResult?.error,
            reason: exec.reason ?? null,
            error: exec.toolResult?.error ?? null,
          };
          await logActivity(db, {
            companyId: approval.companyId,
            actorType: "user",
            actorId: decidedByUserId,
            action: exec.ok ? "approval.executed" : "approval.execute_failed",
            entityType: "approval",
            entityId: approval.id,
            details: {
              type: approval.type,
              ok: exec.ok,
              reason: exec.reason ?? null,
              hadError: !!exec.toolResult?.error,
              ...pluginSource,
            },
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
          };
          logger.warn({ approvalId: approval.id }, "outbound_tool_draft approved but no dispatcher available");
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

    return { approval, applied, draftExecution };
  }

  async function reject(input: ApprovalDecisionInput): Promise<ApprovalDecisionResult> {
    const { approval, applied } = await svc.reject(input.approvalId, input.decidedByUserId, input.decisionNote ?? undefined);

    if (applied) {
      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: input.decidedByUserId,
        action: "approval.rejected",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type, ...pluginSourceDetails(input) },
      });
    }

    return { approval, applied, draftExecution: null };
  }

  return { approve, reject };
}
