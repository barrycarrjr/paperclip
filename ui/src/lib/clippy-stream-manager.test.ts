import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatStreamEvent } from "./chat-stream";

// Controllable fake of the SSE layer: each startTurn gets its own handle
// whose events the test drives and whose done promise the test resolves.
interface FakeHandle {
  onEvent: (event: ChatStreamEvent) => void;
  resolveDone: () => void;
  abort: ReturnType<typeof vi.fn>;
}
const handles: FakeHandle[] = [];

vi.mock("./chat-stream", () => ({
  postChatMessageStream: vi.fn(
    (_sessionId: string, _text: string, onEvent: (e: ChatStreamEvent) => void) => {
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      const handle: FakeHandle = { onEvent, resolveDone, abort: vi.fn() };
      handles.push(handle);
      return { done, abort: handle.abort };
    },
  ),
}));

import { clippyStreamManager } from "./clippy-stream-manager";

const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

let sessionCounter = 0;
function freshSession(): string {
  sessionCounter += 1;
  return `session-${sessionCounter}`;
}

beforeEach(() => {
  handles.length = 0;
});

describe("clippyStreamManager", () => {
  it("a stale finally from a stopped-and-replaced turn cannot break the new turn", async () => {
    const sid = freshSession();
    clippyStreamManager.startTurn(sid, "first", []);
    const turnA = handles[0];

    // Stop-and-send: abort the old turn and start a new one synchronously,
    // exactly like useChatSession.send with force:true.
    clippyStreamManager.abortLocal(sid);
    clippyStreamManager.startTurn(sid, "second", []);
    const turnB = handles[1];

    // Turn A's done promise settles only now — after B is registered.
    turnA.resolveDone();
    await flushMicrotasks();

    // B must still be streaming (the stale finally must not wipe it) …
    turnB.onEvent({ type: "text_delta", delta: "hello" });
    expect(clippyStreamManager.getSnapshot(sid).streaming).toBe(true);
    expect(clippyStreamManager.getSnapshot(sid).pendingAssistant?.blocks).toEqual([
      { type: "text", text: "hello" },
    ]);

    // … and Stop must still reach B's fetch (the stale finally must not
    // have deleted B's abort handle).
    clippyStreamManager.abortLocal(sid);
    expect(turnB.abort).toHaveBeenCalled();
  });

  it("a completed turn still cleans up after itself", async () => {
    const sid = freshSession();
    clippyStreamManager.startTurn(sid, "hi", []);
    const turn = handles[0];
    // SSE ends without a terminal done/error event (network drop).
    turn.resolveDone();
    await flushMicrotasks();
    expect(clippyStreamManager.getSnapshot(sid).streaming).toBe(false);
    // A new turn can start (the aborts entry is gone).
    expect(() => clippyStreamManager.startTurn(sid, "again", [])).not.toThrow();
  });

  it("abortLocal marks unfinished tool calls interrupted instead of running forever", () => {
    const sid = freshSession();
    clippyStreamManager.startTurn(sid, "hi", []);
    const turn = handles[0];
    turn.onEvent({
      type: "tool_use_block",
      toolUseId: "tu-1",
      name: "create_issue",
      input: {},
      mutating: true,
    });
    clippyStreamManager.abortLocal(sid);
    const call = clippyStreamManager.getSnapshot(sid).toolCalls["tu-1"];
    expect(call.completedAt).not.toBeNull();
    expect(call.result?.ok).toBe(false);
  });

  it("counts pending permissions across sessions and forgets disposed sessions", () => {
    const before = clippyStreamManager.getPendingActionCount();
    const sid = freshSession();
    clippyStreamManager.startTurn(sid, "hi", []);
    handles[0].onEvent({
      type: "permission_required",
      toolUseId: "tu-1",
      name: "create_issue",
      input: {},
      ttlMs: 60_000,
    });
    expect(clippyStreamManager.getPendingActionCount()).toBe(before + 1);

    const globalListener = vi.fn();
    const unsubscribe = clippyStreamManager.subscribeGlobal(globalListener);
    clippyStreamManager.disposeSession(sid);
    expect(clippyStreamManager.getPendingActionCount()).toBe(before);
    expect(handles[0].abort).toHaveBeenCalled();
    expect(globalListener).toHaveBeenCalled();
    unsubscribe();
  });
});
