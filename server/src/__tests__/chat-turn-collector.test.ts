import { describe, expect, it } from "vitest";
import { DRAFT_RESULT_HEADER } from "../services/tool-draft-gate.js";
import { createChatTurnCollector, draftedApprovalIdFromToolResult } from "../services/chat-turn-collector.js";
import type { StreamEvent } from "../services/chat.js";

const APPROVAL = "3f1c2b4e-9d8a-4c7b-8e6f-0a1b2c3d4e5f";

function collect(events: StreamEvent[]) {
  const collector = createChatTurnCollector();
  for (const event of events) collector.add(event);
  return collector.result();
}

describe("draftedApprovalIdFromToolResult", () => {
  it("reads every shape a drafted result reaches a chat turn in", () => {
    // A native Clippy tool: the text the model sees.
    expect(draftedApprovalIdFromToolResult(`${DRAFT_RESULT_HEADER}\nSummary: x\nApproval ID: ${APPROVAL}\n`)).toBe(APPROVAL);
    // The full tool result.
    expect(draftedApprovalIdFromToolResult({ data: { drafted: true, approvalId: APPROVAL } })).toBe(APPROVAL);
    expect(draftedApprovalIdFromToolResult({ content: `${DRAFT_RESULT_HEADER}\nApproval ID: ${APPROVAL}` })).toBe(APPROVAL);
    // The bare data object the MCP bridge reports for Clippy on the Claude CLI.
    expect(draftedApprovalIdFromToolResult({ drafted: true, approvalId: APPROVAL, status: "pending" })).toBe(APPROVAL);
  });

  it("ignores ordinary results", () => {
    expect(draftedApprovalIdFromToolResult("Sent.")).toBeNull();
    expect(draftedApprovalIdFromToolResult({ data: { sent: true } })).toBeNull();
    expect(draftedApprovalIdFromToolResult(null)).toBeNull();
  });
});

describe("createChatTurnCollector", () => {
  it("joins the reply, putting each assistant message on its own paragraph", () => {
    const result = collect([
      { type: "message_started", messageId: "m1", role: "assistant" },
      { type: "text_delta", delta: "Checking the invoices." },
      { type: "message_completed", messageId: "m1" },
      { type: "message_started", messageId: "m2", role: "assistant" },
      { type: "text_delta", delta: "Two are overdue." },
      { type: "done", stopReason: "end_turn" },
    ]);
    expect(result.replyText).toBe("Checking the invoices.\n\nTwo are overdue.");
    expect(result.stopReason).toBe("end_turn");
    expect(result.error).toBeNull();
  });

  it("records tool calls and drafted approvals, without counting confirmation prompts as calls", () => {
    const result = collect([
      { type: "tool_use_block", toolUseId: "t1", name: "list_issues", input: {}, mutating: false },
      { type: "tool_result_block", toolUseId: "t1", ok: true, result: { issues: [] } },
      { type: "tool_use_block", toolUseId: "plugin-1", name: "email-tools__email_send", input: {}, mutating: true },
      { type: "tool_result_block", toolUseId: "plugin-1", ok: true, result: { drafted: true, approvalId: APPROVAL } },
      { type: "tool_use_block", toolUseId: "confirm-1", name: "pbx_call", input: {}, mutating: true },
      { type: "permission_required", toolUseId: "confirm-1", name: "pbx_call", input: {}, ttlMs: 1 },
      { type: "tool_result_block", toolUseId: "confirm-1", ok: false, result: { confirmation: "denied" } },
      { type: "permission_required", toolUseId: "confirm-2", name: "pbx_call", input: {}, ttlMs: 1 },
    ]);
    expect(result.toolCalls).toEqual([
      { name: "list_issues", ok: true },
      { name: "email-tools__email_send", ok: true },
    ]);
    expect(result.draftedApprovalIds).toEqual([APPROVAL]);
    expect(result.needsConfirmation).toEqual(["pbx_call"]);
  });

  it("keeps what was said when the turn fails part way", () => {
    const collector = createChatTurnCollector();
    collector.add({ type: "text_delta", delta: "Working on it" });
    collector.add({ type: "error", error: "Tool loop exceeded max iterations" });
    collector.fail("a later failure does not replace the first");
    expect(collector.result()).toMatchObject({
      replyText: "Working on it",
      stopReason: "error",
      error: "Tool loop exceeded max iterations",
    });
  });
});
