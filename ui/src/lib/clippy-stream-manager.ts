import type { ChatContentBlock } from "../api/chat";
import { postChatMessageStream, type ChatStreamEvent } from "./chat-stream";

export interface PendingPermission {
  toolUseId: string;
  name: string;
  input: unknown;
}

export interface ClippyTranscriptEntry {
  id: string;
  role: "user" | "assistant" | "tool";
  blocks: ChatContentBlock[];
  pending?: boolean;
}

export interface SessionStreamState {
  streaming: boolean;
  pendingAssistant: ClippyTranscriptEntry | null;
  pendingPermissions: PendingPermission[];
}

const EMPTY_STATE: SessionStreamState = {
  streaming: false,
  pendingAssistant: null,
  pendingPermissions: [],
};

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

function getState(sessionId: string): SessionStreamState {
  return states.get(sessionId) ?? EMPTY_STATE;
}

function notify(sessionId: string) {
  const subs = listeners.get(sessionId);
  if (!subs) return;
  for (const fn of subs) fn();
}

function setState(
  sessionId: string,
  updater: (prev: SessionStreamState) => SessionStreamState,
) {
  const next = updater(getState(sessionId));
  states.set(sessionId, next);
  notify(sessionId);
}

function ensurePending(prev: ClippyTranscriptEntry | null): ClippyTranscriptEntry {
  return (
    prev ?? {
      id: `pending-${Date.now()}`,
      role: "assistant",
      blocks: [],
      pending: true,
    }
  );
}

function applyEvent(sessionId: string, event: ChatStreamEvent) {
  switch (event.type) {
    case "message_started":
      setState(sessionId, (prev) => ({
        ...prev,
        streaming: true,
        pendingAssistant: ensurePending(prev.pendingAssistant),
      }));
      break;
    case "text_delta":
      setState(sessionId, (prev) => {
        const base = ensurePending(prev.pendingAssistant);
        const blocks = [...base.blocks];
        const last = blocks[blocks.length - 1];
        if (last && last.type === "text") {
          blocks[blocks.length - 1] = { type: "text", text: last.text + event.delta };
        } else {
          blocks.push({ type: "text", text: event.delta });
        }
        return { ...prev, streaming: true, pendingAssistant: { ...base, blocks } };
      });
      break;
    case "tool_use_block":
      setState(sessionId, (prev) => {
        const base = ensurePending(prev.pendingAssistant);
        return {
          ...prev,
          streaming: true,
          pendingAssistant: {
            ...base,
            blocks: [
              ...base.blocks,
              { type: "tool_use", id: event.toolUseId, name: event.name, input: event.input },
            ],
          },
        };
      });
      break;
    case "permission_required":
      setState(sessionId, (prev) => ({
        ...prev,
        pendingPermissions: [
          ...prev.pendingPermissions,
          { toolUseId: event.toolUseId, name: event.name, input: event.input },
        ],
      }));
      break;
    case "tool_result_block":
      setState(sessionId, (prev) => ({
        ...prev,
        pendingPermissions: prev.pendingPermissions.filter(
          (p) => p.toolUseId !== event.toolUseId,
        ),
      }));
      break;
    case "message_completed":
      setState(sessionId, (prev) => ({ ...prev, pendingAssistant: null }));
      refreshCallbacks.get(sessionId)?.onMessage?.();
      break;
    case "session_state":
      refreshCallbacks.get(sessionId)?.onMessage?.();
      break;
    case "done":
      setState(sessionId, () => EMPTY_STATE);
      refreshCallbacks.get(sessionId)?.onDone?.();
      break;
    case "error":
      setState(sessionId, () => ({
        streaming: false,
        pendingAssistant: {
          id: `pending-error-${Date.now()}`,
          role: "assistant",
          blocks: [{ type: "text", text: `Error: ${event.error}` }],
        },
        pendingPermissions: [],
      }));
      refreshCallbacks.get(sessionId)?.onMessage?.();
      break;
    case "ping":
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
      streaming: true,
      pendingAssistant: {
        id: `pending-${Date.now()}`,
        role: "assistant",
        blocks: [],
        pending: true,
      },
      pendingPermissions: [],
    }));

    const handle = postChatMessageStream(
      sessionId,
      text,
      (event) => applyEvent(sessionId, event),
      attachmentIds,
    );
    aborts.set(sessionId, handle.abort);

    const done = handle.done.finally(() => {
      aborts.delete(sessionId);
      // Defensive: if the SSE returned without a terminal `done`/`error`
      // event (network drop), still clear streaming so the UI isn't stuck.
      if (getState(sessionId).streaming) {
        setState(sessionId, () => EMPTY_STATE);
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
    setState(sessionId, () => EMPTY_STATE);
  },
};
