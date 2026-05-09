/**
 * Tool Draft Gate — the trust loop.
 *
 * When an agent calls a mutating outbound tool (send email, post to Slack,
 * place a phone call), the gate intercepts the call, persists the parameters
 * as a pending approval, and returns a synthesized "drafted, awaiting your
 * tap" result to the agent. The user reviews the draft in their inbox /
 * morning brief and approves to actually execute the tool, or rejects to
 * drop it.
 *
 * This is the wiring change that turns the existing action surface (which
 * could already send emails / DMs / make calls) into a draft queue: the
 * agent does the same work, but the side effect waits on a one-tap human
 * review.
 *
 * Scope:
 *   - Hardcoded gate list (see OUTBOUND_TOOL_DRAFT_GATE in @paperclipai/shared).
 *   - Single instance setting (`outboundToolDraftMode`) to enable/disable.
 *   - Re-execution of approved drafts goes through the same dispatcher path
 *     the agent would have taken, so manifest validation, capability checks,
 *     and worker routing are all unchanged.
 */

import type { Db } from "@paperclipai/db";
import { OUTBOUND_TOOL_DRAFT_GATE } from "@paperclipai/shared";
import type { ToolRunContext, ToolResult } from "@paperclipai/plugin-sdk";
import { approvalService } from "./approvals.js";
import { instanceSettingsService } from "./instance-settings.js";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";

const log = logger.child({ service: "tool-draft-gate" });

/**
 * The set of tool names the gate intercepts, materialized as a Set for O(1)
 * lookup. Names are in `<pluginKey>:<toolName>` form, matching the namespaced
 * names that flow through `dispatcher.executeTool`.
 */
const GATED_TOOLS = new Set<string>(OUTBOUND_TOOL_DRAFT_GATE);

/**
 * Header marker placed in the agent-facing tool result when a call is
 * drafted. Adapters / agent prompts can detect this prefix to recognize
 * "do not retry; draft is queued."
 */
export const DRAFT_RESULT_HEADER = "[paperclip:tool-draft] queued for human approval";

interface DraftGateOptions {
  db: Db;
  /**
   * Default override for the instance-wide enable flag — used in tests.
   * In production the flag is read from instance settings on each call so
   * operators can toggle without restart.
   */
  defaultEnabled?: boolean;
}

export interface DraftGateInterceptResult {
  intercepted: boolean;
  result?: ToolResult;
}

export interface DraftGate {
  /**
   * Check whether a given tool call should be drafted instead of executed.
   * If yes, persists an approval and returns the synthesized tool result
   * (so the agent receives a non-error response that says "drafted").
   *
   * If no, returns `{ intercepted: false }` and the dispatcher proceeds
   * with normal execution.
   */
  intercept(
    namespacedName: string,
    parameters: unknown,
    runContext: ToolRunContext,
  ): Promise<DraftGateInterceptResult>;

  /**
   * Whether the gate currently considers the given tool name draftable.
   * Cheap; safe to call on every dispatch. Does not consult the DB.
   */
  isGated(namespacedName: string): boolean;
}

/**
 * Synthetic agentId prefix used by chat-Agent (Clippy) and the plugin MCP
 * bridge when a real agent run isn't available. Format: `clippy:<userId>`.
 * The suffix is the auth user id (text, not a UUID), so the synthetic id
 * fails to cast into the `uuid` columns on `approvals.requested_by_agent_id`
 * and `activity_log.agent_id`. Detect it here and route the attribution to
 * the user-id columns instead.
 */
const CLIPPY_AGENT_PREFIX = "clippy:";

interface ResolvedRunActor {
  /** Real agent UUID, or null when the caller is Clippy / unknown. */
  agentUuid: string | null;
  /** Real heartbeat run UUID, or null when the caller is Clippy / unknown. */
  runUuid: string | null;
  /** Auth user id, when the caller is Clippy. */
  userId: string | null;
  /** Activity-log actor classification. */
  actorType: "agent" | "user" | "system";
  actorId: string;
}

function resolveRunActor(runContext: ToolRunContext): ResolvedRunActor {
  const rawAgentId = runContext.agentId ?? "";
  if (rawAgentId.startsWith(CLIPPY_AGENT_PREFIX)) {
    const userId = rawAgentId.slice(CLIPPY_AGENT_PREFIX.length) || null;
    return {
      agentUuid: null,
      // The synthetic runId from chat-tools is a randomUUID() that doesn't
      // exist in heartbeat_runs, so the FK would reject it the same way the
      // agent_id cast rejects the prefixed string. Drop it.
      runUuid: null,
      userId,
      actorType: userId ? "user" : "system",
      actorId: userId ?? "system",
    };
  }
  if (rawAgentId) {
    return {
      agentUuid: rawAgentId,
      runUuid: runContext.runId ?? null,
      userId: null,
      actorType: "agent",
      actorId: rawAgentId,
    };
  }
  return {
    agentUuid: null,
    runUuid: null,
    userId: null,
    actorType: "system",
    actorId: "system",
  };
}

/**
 * Generate a short human-readable summary from the call parameters, used as
 * the approval payload `summary` so it renders without requiring the user
 * to expand the full args. Best-effort: pulls common fields like `to`,
 * `subject`, `text`, `body`, `channel`, `phoneNumber`.
 */
function buildSummary(toolName: string, params: unknown): string {
  if (!params || typeof params !== "object") return toolName;
  const p = params as Record<string, unknown>;
  const candidate = (k: string): string | null => {
    const v = p[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };

  const recipient =
    candidate("to") ??
    candidate("recipient") ??
    candidate("channel") ??
    candidate("user") ??
    candidate("phoneNumber") ??
    candidate("conversationId");
  const subject = candidate("subject") ?? candidate("title");
  const body =
    candidate("body") ??
    candidate("text") ??
    candidate("message") ??
    candidate("html");

  const parts: string[] = [];
  if (recipient) parts.push(`to ${recipient}`);
  if (subject) parts.push(`re: ${subject}`);
  if (body) {
    const trimmed = body.length > 140 ? `${body.slice(0, 137)}…` : body;
    parts.push(`— "${trimmed}"`);
  }

  return parts.length > 0 ? parts.join(" ") : toolName;
}

export function createDraftGate(opts: DraftGateOptions): DraftGate {
  const { db } = opts;
  const settings = instanceSettingsService(db);
  const approvals = approvalService(db);

  async function isEnabled(): Promise<boolean> {
    try {
      const general = await settings.getGeneral();
      // The setting is read off the record by name without widening the
      // generic type because adding it to InstanceGeneralSettings is a
      // separate, schema-level change. Until then we treat the absence of
      // the flag as "fall through to the default".
      const flag = (general as unknown as Record<string, unknown>).outboundToolDraftMode;
      if (typeof flag === "boolean") return flag;
    } catch (err) {
      log.warn({ err }, "failed to read outboundToolDraftMode flag; assuming default");
    }
    return opts.defaultEnabled ?? true;
  }

  return {
    isGated(namespacedName: string) {
      return GATED_TOOLS.has(namespacedName);
    },

    async intercept(
      namespacedName: string,
      parameters: unknown,
      runContext: ToolRunContext,
    ): Promise<DraftGateInterceptResult> {
      if (!GATED_TOOLS.has(namespacedName)) {
        return { intercepted: false };
      }
      if (!(await isEnabled())) {
        return { intercepted: false };
      }
      // The gate is meaningless without a company to scope the approval to.
      // Bail out (uncaptured) rather than fail the call — the dispatcher's
      // existing checks will surface a clearer error if companyId truly is
      // required for this tool.
      if (!runContext.companyId) {
        log.warn(
          { tool: namespacedName, agentId: runContext.agentId },
          "draft gate skipped — no companyId on runContext",
        );
        return { intercepted: false };
      }

      const summary = buildSummary(namespacedName, parameters);
      const actor = resolveRunActor(runContext);
      const payload = {
        toolName: namespacedName,
        parameters: parameters ?? null,
        summary,
        agentId: runContext.agentId ?? null,
        runId: runContext.runId ?? null,
        // Set when the gate is invoked from a chat-Agent (Clippy) turn — see
        // chat-tools.ts and plugin-mcp-bridge.ts. Used by the approve route to
        // append a follow-up tool-result message into the chat transcript so
        // Clippy can pick up where it left off after the user resolves the
        // draft. Null/absent for ordinary agent runs (those wake via heartbeat).
        chatSessionId: runContext.chatSessionId ?? null,
        draftedAt: new Date().toISOString(),
      } satisfies Record<string, unknown>;

      const approval = await approvals.create(runContext.companyId, {
        type: "outbound_tool_draft",
        status: "pending",
        requestedByAgentId: actor.agentUuid,
        requestedByUserId: actor.userId,
        payload,
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
      });

      // Drop a receipt-style activity entry so the draft surfaces in the
      // Receipt feed and Morning Brief as a "drafted" outcome immediately,
      // not only after the user resolves it.
      try {
        await logActivity(db, {
          companyId: runContext.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          action: "approval.created",
          entityType: "approval",
          entityId: approval.id,
          agentId: actor.agentUuid,
          runId: actor.runUuid,
          details: {
            type: "outbound_tool_draft",
            tool: namespacedName,
            summary,
          },
        });
      } catch (err) {
        log.warn({ err, approvalId: approval.id }, "failed to log draft activity (non-fatal)");
      }

      log.info(
        {
          approvalId: approval.id,
          tool: namespacedName,
          companyId: runContext.companyId,
          agentId: runContext.agentId,
        },
        "outbound tool drafted as approval",
      );

      // Real agent runs get an `approval_approved` heartbeat wake when the
      // user resolves the draft (see approvals.ts approve route). Chat-Agent
      // (Clippy) callers don't — there's no chat-session wake hook — so tell
      // them to end the turn cleanly instead of "wait for the wake".
      const guidance = actor.actorType === "agent"
        ? "The user must approve this draft before it executes. Do not retry the tool — wait for the approval.resolved wake."
        : "The user must approve this draft before it executes. Do not retry the tool. Tell the user it is queued and end your turn — you will not be woken when they approve.";

      const content = [
        DRAFT_RESULT_HEADER,
        `Tool: ${namespacedName}`,
        `Approval ID: ${approval.id}`,
        summary ? `Summary: ${summary}` : null,
        "",
        guidance,
      ]
        .filter((line): line is string => line !== null)
        .join("\n");

      return {
        intercepted: true,
        result: {
          content,
          data: {
            drafted: true,
            approvalId: approval.id,
            status: "pending",
            tool: namespacedName,
            summary,
          },
        },
      };
    },
  };
}

/**
 * Look up the approval by ID and re-dispatch its saved tool call as if the
 * agent had executed it directly. Caller is responsible for guarding that
 * the approval was newly transitioned to `approved` (so we don't double-run).
 *
 * Returns the underlying tool result, or `null` if the approval doesn't
 * carry a draftable payload (e.g. type mismatch, malformed payload).
 */
export interface ExecuteDraftedApprovalArgs {
  approvalId: string;
  decidedByUserId: string;
  executeTool: (
    namespacedName: string,
    parameters: unknown,
    runContext: ToolRunContext,
  ) => Promise<{ result: ToolResult }>;
  db: Db;
}

export async function executeDraftedApproval(
  args: ExecuteDraftedApprovalArgs,
): Promise<{ ok: boolean; toolResult?: ToolResult; reason?: string }> {
  const approvals = approvalService(args.db);
  const approval = await approvals.getById(args.approvalId);
  if (!approval) return { ok: false, reason: "approval_not_found" };
  if (approval.type !== "outbound_tool_draft")
    return { ok: false, reason: "wrong_type" };

  const payload = approval.payload as Record<string, unknown> | null;
  const toolName = typeof payload?.toolName === "string" ? payload.toolName : null;
  if (!toolName) return { ok: false, reason: "missing_tool_name" };
  const parameters = payload?.parameters ?? {};
  const originalAgentId =
    typeof payload?.agentId === "string" ? payload.agentId : approval.requestedByAgentId;

  // Re-dispatch via the same dispatcher path. The agentId is the same one
  // that drafted, so company-scope checks and audit attribution stay correct.
  const runContext: ToolRunContext = {
    companyId: approval.companyId,
    agentId: originalAgentId ?? "draft-approval",
    runId: typeof payload?.runId === "string" ? payload.runId : `approval:${approval.id}`,
    projectId: "",
  };

  try {
    const exec = await args.executeTool(toolName, parameters, runContext);
    log.info(
      {
        approvalId: args.approvalId,
        tool: toolName,
        companyId: approval.companyId,
        hasError: !!exec.result.error,
      },
      "drafted tool executed after approval",
    );
    return { ok: true, toolResult: exec.result };
  } catch (err) {
    log.error(
      { err, approvalId: args.approvalId, tool: toolName },
      "drafted tool execution failed",
    );
    return { ok: false, reason: err instanceof Error ? err.message : "execution_failed" };
  }
}
