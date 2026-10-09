/**
 * Turn Clippy's event stream into one answer.
 *
 * The browser consumes `runTurn` as a live stream; a chat app such as Slack
 * cannot, it needs the finished reply plus a few facts about the turn: which
 * tools ran, which needed a yes the chat app cannot give, and which drafted
 * outbound actions are waiting for approval.
 *
 * Events arrive from two places and both are fed in here: the turn's own
 * stream, and the live-interaction channel that tools reached over the MCP
 * bridge (Clippy on the Claude CLI) report through.
 */
import type { StreamEvent } from "./chat.js";
import { DRAFT_RESULT_HEADER } from "./tool-draft-gate.js";

export interface CollectedChatTurn {
  replyText: string;
  stopReason: string;
  /** Approval ids found in drafted tool results during this turn, in order. */
  draftedApprovalIds: string[];
  /** Tools that needed the user's yes, in order, without repeats. */
  needsConfirmation: string[];
  toolCalls: Array<{ name: string; ok: boolean }>;
  /** Set when the turn failed part way. */
  error: string | null;
}

const APPROVAL_ID_LINE = /^Approval ID:\s*([0-9a-f-]{36})\s*$/im;

/**
 * The approval id a drafted tool result carries, if it is one. Covers every
 * shape the draft gate's result reaches a chat turn in: the text block a
 * native Clippy tool returns, the `{ content, data }` tool result, and the
 * bare `data` object the MCP bridge reports.
 */
export function draftedApprovalIdFromToolResult(result: unknown): string | null {
  if (typeof result === "string") {
    return result.startsWith(DRAFT_RESULT_HEADER) ? (APPROVAL_ID_LINE.exec(result)?.[1] ?? null) : null;
  }
  if (!result || typeof result !== "object") return null;
  const record = result as { content?: unknown; data?: unknown; drafted?: unknown; approvalId?: unknown };
  if (record.drafted === true && typeof record.approvalId === "string") return record.approvalId;
  const data = record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : null;
  if (data?.drafted === true && typeof data.approvalId === "string") return data.approvalId;
  if (typeof record.content === "string" && record.content.startsWith(DRAFT_RESULT_HEADER)) {
    return APPROVAL_ID_LINE.exec(record.content)?.[1] ?? null;
  }
  return null;
}

export function createChatTurnCollector() {
  let replyText = "";
  // Set when an assistant message ends, so the next one's text starts on a new
  // paragraph instead of running on from the last word of the previous one.
  let separateNextText = false;
  let stopReason = "unknown";
  let error: string | null = null;
  const draftedApprovalIds: string[] = [];
  const needsConfirmation: string[] = [];
  const toolCalls: Array<{ name: string; ok: boolean }> = [];
  const toolNames = new Map<string, string>();

  function add(event: StreamEvent) {
    switch (event.type) {
      case "message_started":
        if (replyText.trim()) separateNextText = true;
        break;
      case "text_delta":
        if (separateNextText && event.delta.trim()) {
          replyText = `${replyText.trimEnd()}\n\n`;
          separateNextText = false;
        }
        replyText += event.delta;
        break;
      case "tool_use_block":
        toolNames.set(event.toolUseId, event.name);
        break;
      case "tool_result_block": {
        // A confirmation prompt reports its own outcome as a tool result;
        // it is not a tool call of its own.
        if (event.toolUseId.startsWith("confirm-")) break;
        toolCalls.push({ name: toolNames.get(event.toolUseId) ?? "tool", ok: event.ok });
        const approvalId = draftedApprovalIdFromToolResult(event.result);
        if (approvalId && !draftedApprovalIds.includes(approvalId)) draftedApprovalIds.push(approvalId);
        break;
      }
      case "permission_required":
        if (!needsConfirmation.includes(event.name)) needsConfirmation.push(event.name);
        break;
      case "done":
        stopReason = event.stopReason;
        break;
      case "error":
        error = event.error;
        break;
      default:
        break;
    }
  }

  function fail(message: string) {
    error = error ?? message;
  }

  function result(): CollectedChatTurn {
    return {
      replyText: replyText.trim(),
      stopReason: error && stopReason === "unknown" ? "error" : stopReason,
      draftedApprovalIds: [...draftedApprovalIds],
      needsConfirmation: [...needsConfirmation],
      toolCalls: [...toolCalls],
      error,
    };
  }

  return { add, fail, result };
}

export type ChatTurnCollector = ReturnType<typeof createChatTurnCollector>;
