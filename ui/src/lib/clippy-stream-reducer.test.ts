import { describe, expect, it } from "vitest";
import {
  EMPTY_STREAM_STATE,
  finalizeUnfinishedToolCalls,
  reduceClippyStreamEvent,
  resolveStreamActivity,
  type SessionStreamState,
} from "./clippy-stream-reducer";

const NOW = 1_754_000_000_000;

function reduce(
  state: SessionStreamState,
  event: Parameters<typeof reduceClippyStreamEvent>[1],
  now = NOW,
) {
  return reduceClippyStreamEvent(state, event, now);
}

describe("reduceClippyStreamEvent", () => {
  it("records a live tool call with its mutating flag and start time", () => {
    const state = reduce(EMPTY_STREAM_STATE, {
      type: "tool_use_block",
      toolUseId: "tu-1",
      name: "create_issue",
      input: { title: "Do the thing" },
      mutating: true,
    });
    expect(state.toolCalls["tu-1"]).toMatchObject({
      name: "create_issue",
      mutating: true,
      startedAt: NOW,
    });
    expect(state.toolCalls["tu-1"].result).toBeUndefined();
    // The block also lands in the pending assistant entry for rendering.
    expect(state.pendingAssistant?.blocks).toEqual([
      { type: "tool_use", id: "tu-1", name: "create_issue", input: { title: "Do the thing" } },
    ]);
  });

  it("attaches streamed results to the live call and clears its permission", () => {
    let state = reduce(EMPTY_STREAM_STATE, {
      type: "tool_use_block",
      toolUseId: "tu-1",
      name: "create_issue",
      input: {},
      mutating: true,
    });
    state = reduce(state, {
      type: "permission_required",
      toolUseId: "tu-1",
      name: "create_issue",
      input: {},
      ttlMs: 60_000,
    });
    expect(state.pendingPermissions).toHaveLength(1);
    expect(state.pendingPermissions[0].expiresAt).toBe(NOW + 60_000);

    state = reduce(
      state,
      { type: "tool_result_block", toolUseId: "tu-1", ok: true, result: { id: "iss-9" } },
      NOW + 1500,
    );
    expect(state.pendingPermissions).toHaveLength(0);
    expect(state.toolCalls["tu-1"]).toMatchObject({
      result: { ok: true, result: { id: "iss-9" } },
      startedAt: NOW,
      completedAt: NOW + 1500,
    });
  });

  it("falls back to the 5-minute TTL when the event carries none", () => {
    const state = reduce(EMPTY_STREAM_STATE, {
      type: "permission_required",
      toolUseId: "tu-1",
      name: "create_issue",
      input: {},
    });
    expect(state.pendingPermissions[0].expiresAt).toBe(NOW + 5 * 60 * 1000);
  });

  it("keeps live tool calls across done so cards don't flip back to running", () => {
    let state = reduce(EMPTY_STREAM_STATE, {
      type: "tool_use_block",
      toolUseId: "tu-1",
      name: "list_issues",
      input: {},
      mutating: false,
    });
    state = reduce(state, {
      type: "tool_result_block",
      toolUseId: "tu-1",
      ok: true,
      result: [],
    });
    state = reduce(state, { type: "done", stopReason: "tool_drafted" });
    expect(state.streaming).toBe(false);
    expect(state.stopReason).toBe("tool_drafted");
    expect(state.toolCalls["tu-1"].result).toEqual({ ok: true, result: [] });
    expect(state.pendingAssistant).toBeNull();
    expect(state.pendingPermissions).toEqual([]);
  });

  it("keeps live tool calls across error and finalizes unfinished ones", () => {
    let state = reduce(EMPTY_STREAM_STATE, {
      type: "tool_use_block",
      toolUseId: "tu-1",
      name: "list_issues",
      input: {},
      mutating: false,
    });
    state = reduce(state, { type: "error", error: "boom" }, NOW + 500);
    expect(state.streaming).toBe(false);
    // An unfinished call must not tick "running…" forever after the stream
    // dies: it gets an interrupted result and a completion time.
    expect(state.toolCalls["tu-1"].completedAt).toBe(NOW + 500);
    expect(state.toolCalls["tu-1"].result?.ok).toBe(false);
    // The error is appended below whatever the assistant had already produced,
    // not swapped in place of it. Discarding the partial content was what made
    // an interrupted turn look like nothing had happened.
    expect(state.pendingAssistant?.blocks).toEqual([
      { type: "tool_use", id: "tu-1", name: "list_issues", input: {} },
      { type: "text", text: "Error: boom" },
    ]);
  });

  it("keeps partial assistant text when a turn is interrupted", () => {
    let state = reduce(EMPTY_STREAM_STATE, { type: "message_started", messageId: "m1", role: "assistant" });
    state = reduce(state, { type: "text_delta", delta: "Half an ans" });
    state = reduce(state, { type: "error", error: "connection dropped" }, NOW + 500);

    expect(state.pendingAssistant?.blocks).toEqual([
      { type: "text", text: "Half an ans" },
      { type: "text", text: "Error: connection dropped" },
    ]);
  });

  it("appends text deltas to the trailing text block", () => {
    let state = reduce(EMPTY_STREAM_STATE, { type: "message_started", messageId: "m1", role: "assistant" });
    state = reduce(state, { type: "text_delta", delta: "Hel" });
    state = reduce(state, { type: "text_delta", delta: "lo" });
    expect(state.pendingAssistant?.blocks).toEqual([{ type: "text", text: "Hello" }]);
  });

  it("stamps lastEventAt on every non-ping event and leaves ping alone", () => {
    const afterDelta = reduce(EMPTY_STREAM_STATE, { type: "text_delta", delta: "x" }, NOW + 7);
    expect(afterDelta.lastEventAt).toBe(NOW + 7);
    const afterPing = reduce(afterDelta, { type: "ping" }, NOW + 9);
    expect(afterPing).toBe(afterDelta);
  });

  it("clears the pending assistant on message_completed but keeps tool state", () => {
    let state = reduce(EMPTY_STREAM_STATE, {
      type: "tool_use_block",
      toolUseId: "tu-1",
      name: "get_issue",
      input: {},
      mutating: false,
    });
    state = reduce(state, { type: "message_completed", messageId: "m1" });
    expect(state.pendingAssistant).toBeNull();
    expect(state.toolCalls["tu-1"]).toBeDefined();
  });
});

describe("finalizeUnfinishedToolCalls", () => {
  it("returns the same object when nothing is unfinished", () => {
    const calls = {
      "tu-1": {
        toolUseId: "tu-1",
        name: "x",
        mutating: false,
        startedAt: NOW,
        completedAt: NOW + 1,
        result: { ok: true, result: null },
      },
    };
    expect(finalizeUnfinishedToolCalls(calls, NOW + 9)).toBe(calls);
  });
});

describe("resolveStreamActivity", () => {
  const base = {
    streaming: true,
    lastEventAt: NOW,
    hasAssistantContent: true,
    hasPendingPermission: false,
    hasRunningTool: false,
  };
  it("says thinking before any assistant content", () => {
    expect(
      resolveStreamActivity({ ...base, hasAssistantContent: false, now: NOW }),
    ).toEqual({ kind: "thinking" });
  });
  it("shows the quiet line only after the threshold", () => {
    expect(resolveStreamActivity({ ...base, now: NOW + 1000 })).toBeNull();
    expect(resolveStreamActivity({ ...base, now: NOW + 3000 })).toEqual({
      kind: "quiet",
      quietMs: 3000,
    });
  });
  it("stays silent while a permission prompt is waiting on the user", () => {
    expect(
      resolveStreamActivity({ ...base, hasPendingPermission: true, now: NOW + 60_000 }),
    ).toBeNull();
  });
  it("stays silent while a tool card is already showing running", () => {
    expect(
      resolveStreamActivity({ ...base, hasRunningTool: true, now: NOW + 60_000 }),
    ).toBeNull();
  });
  it("returns nothing when not streaming", () => {
    expect(resolveStreamActivity({ ...base, streaming: false, now: NOW + 9000 })).toBeNull();
  });
});
