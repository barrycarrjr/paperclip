import { describe, expect, it } from "vitest";
import { mergeTranscript } from "./clippy-transcript";
import type { ClippyTranscriptEntry } from "./clippy-stream-reducer";
import type { ChatMessage } from "../api/chat";

function msg(id: string, content: ChatMessage["content"]): ChatMessage {
  return {
    id,
    sessionId: "s1",
    role: "assistant",
    content,
    createdAt: new Date().toISOString(),
  } as ChatMessage;
}

describe("mergeTranscript", () => {
  it("drops the streamed entry's tool_use blocks that are already persisted", () => {
    // The server persists the assistant message (triggering the refetch)
    // BEFORE streaming tool_use blocks, so during a tool run the pending
    // entry duplicates the persisted message. Without deduping, a waiting
    // permission prompt renders twice.
    const messages = [
      msg("m1", [
        { type: "text", text: "Let me check." },
        { type: "tool_use", id: "tu-1", name: "create_issue", input: {} },
      ]),
    ];
    const pending: ClippyTranscriptEntry = {
      id: "pending-1",
      role: "assistant",
      blocks: [{ type: "tool_use", id: "tu-1", name: "create_issue", input: {} }],
      pending: true,
    };
    const merged = mergeTranscript(messages, pending);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("m1");
  });

  it("keeps streamed blocks that are not persisted yet", () => {
    const messages = [msg("m1", [{ type: "text", text: "Earlier." }])];
    const pending: ClippyTranscriptEntry = {
      id: "pending-1",
      role: "assistant",
      blocks: [
        { type: "text", text: "Streaming now" },
        { type: "tool_use", id: "tu-9", name: "get_issue", input: {} },
      ],
      pending: true,
    };
    const merged = mergeTranscript(messages, pending);
    expect(merged).toHaveLength(2);
    expect(merged[1].blocks).toHaveLength(2);
  });

  it("keeps the empty just-started placeholder for the typing indicator", () => {
    const pending: ClippyTranscriptEntry = {
      id: "pending-1",
      role: "assistant",
      blocks: [],
      pending: true,
    };
    const merged = mergeTranscript([], pending);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("pending-1");
  });

  it("drops the pending entry once its id is persisted", () => {
    const messages = [msg("pending-1", [{ type: "text", text: "hi" }])];
    const pending: ClippyTranscriptEntry = {
      id: "pending-1",
      role: "assistant",
      blocks: [{ type: "text", text: "hi" }],
    };
    expect(mergeTranscript(messages, pending)).toHaveLength(1);
  });
});
