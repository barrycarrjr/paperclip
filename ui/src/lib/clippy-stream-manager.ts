import { postChatMessageStream, type ChatStreamEvent } from "./chat-stream";
import {
  EMPTY_STREAM_STATE,
  finalizeUnfinishedToolCalls,
  reduceClippyStreamEvent,
  type ClippyTranscriptEntry,
  type LiveToolCall,
  type PendingPermission,
  type SessionStreamState,
} from "./clippy-stream-reducer";

export type {
  ClippyTranscriptEntry,
  LiveToolCall,
  PendingPermission,
  SessionStreamState,
} from "./clippy-stream-reducer";
export { EMPTY_STREAM_STATE } from "./clippy-stream-reducer";

type Listener = () => void;

interface RefreshCallbacks {
  onMessage?: () => void;
  onDone?: () => void;
}

// Module-scoped singleton: a chat turn's stream lives here, not inside any
// React component, so closing the drawer (which unmounts useChatSession)
// doesn't kill the SSE connection. Reopening or remounting subscribes the
// new instance to the in-progress state. Cross-window sync (pop-out) is
// handled by blocking pop-out while streaming — see ClippyDrawer.
const states = new Map<string, SessionStreamState>();
const listeners = new Map<string, Set<Listener>>();
const aborts = new Map<string, () => void>();
const refreshCallbacks = new Map<string, RefreshCallbacks>();
// Cross-session listeners (e.g. the drawer launcher badge) notified on any
// session's state change.
const globalListeners = new Set<Listener>();

function getState(sessionId: string): SessionStreamState {
  return states.get(sessionId) ?? EMPTY_STREAM_STATE;
}

function notify(sessionId: string) {
  const subs = listeners.get(sessionId);
  if (subs) {
    for (const fn of subs) fn();
  }
  for (const fn of globalListeners) fn();
}

function setState(
  sessionId: string,
  updater: (prev: SessionStreamState) => SessionStreamState,
) {
  const next = updater(getState(sessionId));
  states.set(sessionId, next);
  notify(sessionId);
}

function applyEvent(sessionId: string, event: ChatStreamEvent) {
  if (event.type !== "ping") {
    setState(sessionId, (prev) => reduceClippyStreamEvent(prev, event, Date.now()));
  }
  switch (event.type) {
    case "message_completed":
    case "session_state":
      refreshCallbacks.get(sessionId)?.onMessage?.();
      break;
    case "done":
      refreshCallbacks.get(sessionId)?.onDone?.();
      break;
    case "error":
      refreshCallbacks.get(sessionId)?.onMessage?.();
      break;
    default:
      break;
  }
}

export const clippyStreamManager = {
  subscribe(sessionId: string, listener: Listener): () => void {
    let subs = listeners.get(sessionId);
    if (!subs) {
      subs = new Set();
      listeners.set(sessionId, subs);
    }
    subs.add(listener);
    return () => {
      const set = listeners.get(sessionId);
      if (!set) return;
      set.delete(listener);
      if (set.size === 0) listeners.delete(sessionId);
    };
  },

  getSnapshot(sessionId: string): SessionStreamState {
    return getState(sessionId);
  },

  /** Subscribe to changes in any session's stream state. */
  subscribeGlobal(listener: Listener): () => void {
    globalListeners.add(listener);
    return () => {
      globalListeners.delete(listener);
    };
  },

  /**
   * Number of actions across all sessions waiting on the user right now
   * (pending permission prompts). Powers the launcher-button badge.
   */
  getPendingActionCount(): number {
    let count = 0;
    for (const state of states.values()) {
      count += state.pendingPermissions.length;
    }
    return count;
  },

  setRefreshCallbacks(sessionId: string, callbacks: RefreshCallbacks) {
    refreshCallbacks.set(sessionId, callbacks);
  },

  startTurn(
    sessionId: string,
    text: string,
    attachmentIds: string[],
  ): { abort: () => void; done: Promise<void> } {
    if (aborts.has(sessionId)) {
      throw new Error("A turn is already streaming");
    }
    setState(sessionId, () => ({
      ...EMPTY_STREAM_STATE,
      streaming: true,
      pendingAssistant: {
        id: `pending-${Date.now()}`,
        role: "assistant",
        blocks: [],
        pending: true,
      },
      lastEventAt: Date.now(),
    }));

    const handle = postChatMessageStream(
      sessionId,
      text,
      (event) => applyEvent(sessionId, event),
      attachmentIds,
    );
    aborts.set(sessionId, handle.abort);

    const done = handle.done.finally(() => {
      // Only clean up if this turn still owns the session. A stop-and-send
      // replaces the aborts entry synchronously before this settles; a plain
      // Stop deletes it. In both cases this stale finally must not delete
      // the new turn's abort handle or wipe its state.
      if (aborts.get(sessionId) !== handle.abort) return;
      aborts.delete(sessionId);
      // Backstop only. postChatMessageStream now synthesises an `error` event
      // when the stream ends without a terminal one, so a drop normally
      // arrives through applyEvent and keeps its partial content. If we still
      // land here streaming, clear it so the UI isn't stuck spinning — but
      // keep the partial assistant text rather than wiping it, because
      // silently discarding it is what made dropped turns look like nothing
      // had happened at all.
      if (getState(sessionId).streaming) {
        setState(sessionId, (prev) => ({
          ...EMPTY_STREAM_STATE,
          pendingAssistant: prev.pendingAssistant,
          toolCalls: finalizeUnfinishedToolCalls(prev.toolCalls, Date.now()),
        }));
      }
    });

    return { abort: handle.abort, done };
  },

  abortLocal(sessionId: string) {
    const fn = aborts.get(sessionId);
    if (fn) {
      fn();
      aborts.delete(sessionId);
    }
    // Keep tool-call evidence: completed calls stay completed, unfinished
    // ones are marked interrupted instead of ticking "running…" forever.
    setState(sessionId, (prev) => ({
      ...EMPTY_STREAM_STATE,
      toolCalls: finalizeUnfinishedToolCalls(prev.toolCalls, Date.now()),
    }));
  },

  /**
   * Forget a session entirely (e.g. after it is deleted). Aborts any
   * in-flight turn — closing the POST socket also cancels the server-side
   * permission wait — and drops its state so pending prompts stop counting
   * toward the launcher badge.
   */
  disposeSession(sessionId: string) {
    const fn = aborts.get(sessionId);
    if (fn) {
      fn();
      aborts.delete(sessionId);
    }
    states.delete(sessionId);
    refreshCallbacks.delete(sessionId);
    notify(sessionId);
  },
};
