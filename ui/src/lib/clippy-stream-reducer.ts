import type { ChatContentBlock } from "../api/chat";
import type { ChatStreamEvent } from "./chat-stream";

export interface PendingPermission {
  toolUseId: string;
  name: string;
  input: unknown;
  /** Epoch ms when the server will auto-deny this request (from ttlMs). */
  expiresAt?: number;
}

/**
 * Live view of one tool call during (and just after) a streaming turn.
 * Persisted tool_result blocks are the canonical record; this exists so the
 * UI can show mutating/read badges, elapsed time, and results the moment
 * they stream in, instead of waiting for the next react-query refetch.
 */
export interface LiveToolCall {
  toolUseId: string;
  name: string;
  mutating: boolean;
  startedAt: number;
  result?: { ok: boolean; result: unknown };
  completedAt?: number;
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
  toolCalls: Record<string, LiveToolCall>;
  /** Epoch ms of the last non-ping stream event; drives the quiet indicator. */
  lastEventAt: number | null;
  /** stopReason from the last `done` event of a finished turn. */
  stopReason: string | null;
}

export const EMPTY_STREAM_STATE: SessionStreamState = {
  streaming: false,
  pendingAssistant: null,
  pendingPermissions: [],
  toolCalls: {},
  lastEventAt: null,
  stopReason: null,
};

/** Server default TTL for chat permission prompts; used when the event
 * doesn't carry ttlMs (older server). Mirrors CHAT_PERMISSION_TTL_MS. */
const FALLBACK_PERMISSION_TTL_MS = 5 * 60 * 1000;

function ensurePending(prev: ClippyTranscriptEntry | null, now: number): ClippyTranscriptEntry {
  return (
    prev ?? {
      id: `pending-${now}`,
      role: "assistant",
      blocks: [],
      pending: true,
    }
  );
}

/**
 * Pure reducer for one session's stream state. Side effects (refresh
 * callbacks, SSE lifecycle) live in clippy-stream-manager; keeping this
 * pure makes every event transition unit-testable.
 */
export function reduceClippyStreamEvent(
  prev: SessionStreamState,
  event: ChatStreamEvent,
  now: number,
): SessionStreamState {
  switch (event.type) {
    case "message_started":
      return {
        ...prev,
        streaming: true,
        lastEventAt: now,
        pendingAssistant: ensurePending(prev.pendingAssistant, now),
      };
    case "text_delta": {
      const base = ensurePending(prev.pendingAssistant, now);
      const blocks = [...base.blocks];
      const last = blocks[blocks.length - 1];
      if (last && last.type === "text") {
        blocks[blocks.length - 1] = { type: "text", text: last.text + event.delta };
      } else {
        blocks.push({ type: "text", text: event.delta });
      }
      return {
        ...prev,
        streaming: true,
        lastEventAt: now,
        pendingAssistant: { ...base, blocks },
      };
    }
    case "tool_use_block": {
      const base = ensurePending(prev.pendingAssistant, now);
      return {
        ...prev,
        streaming: true,
        lastEventAt: now,
        pendingAssistant: {
          ...base,
          blocks: [
            ...base.blocks,
            { type: "tool_use", id: event.toolUseId, name: event.name, input: event.input },
          ],
        },
        toolCalls: {
          ...prev.toolCalls,
          [event.toolUseId]: {
            toolUseId: event.toolUseId,
            name: event.name,
            mutating: event.mutating,
            startedAt: now,
          },
        },
      };
    }
    case "permission_required":
      return {
        ...prev,
        lastEventAt: now,
        pendingPermissions: [
          ...prev.pendingPermissions,
          {
            toolUseId: event.toolUseId,
            name: event.name,
            input: event.input,
            expiresAt: now + (event.ttlMs ?? FALLBACK_PERMISSION_TTL_MS),
          },
        ],
      };
    case "tool_result_block": {
      const existing = prev.toolCalls[event.toolUseId];
      return {
        ...prev,
        lastEventAt: now,
        toolCalls: {
          ...prev.toolCalls,
          [event.toolUseId]: {
            toolUseId: event.toolUseId,
            name: existing?.name ?? "",
            mutating: existing?.mutating ?? false,
            startedAt: existing?.startedAt ?? now,
            result: { ok: event.ok, result: event.result },
            completedAt: now,
          },
        },
        pendingPermissions: prev.pendingPermissions.filter(
          (p) => p.toolUseId !== event.toolUseId,
        ),
      };
    }
    case "message_completed":
      return { ...prev, lastEventAt: now, pendingAssistant: null };
    case "session_state":
      return { ...prev, lastEventAt: now };
    case "done":
      // Keep toolCalls: persisted results may not have refetched yet, and
      // wiping them would flip finished cards back to "running…" briefly.
      return {
        ...EMPTY_STREAM_STATE,
        toolCalls: prev.toolCalls,
        lastEventAt: now,
        stopReason: event.stopReason,
      };
    case "error":
      return {
        ...EMPTY_STREAM_STATE,
        toolCalls: finalizeUnfinishedToolCalls(prev.toolCalls, now),
        lastEventAt: now,
        pendingAssistant: {
          id: `pending-error-${now}`,
          role: "assistant",
          blocks: [{ type: "text", text: `Error: ${event.error}` }],
        },
      };
    case "ping":
      return prev;
  }
}

/**
 * Mark tool calls that never received a result as failed-by-interruption so
 * their cards stop ticking "running…" after the stream dies (error event,
 * network drop, or Stop).
 */
export function finalizeUnfinishedToolCalls(
  toolCalls: Record<string, LiveToolCall>,
  now: number,
): Record<string, LiveToolCall> {
  let changed = false;
  const next: Record<string, LiveToolCall> = {};
  for (const [id, call] of Object.entries(toolCalls)) {
    if (call.completedAt == null) {
      changed = true;
      next[id] = {
        ...call,
        completedAt: now,
        result: {
          ok: false,
          result: { error: "Interrupted: the connection ended before a result arrived." },
        },
      };
    } else {
      next[id] = call;
    }
  }
  return changed ? next : toolCalls;
}

export type StreamActivity =
  | { kind: "thinking" }
  | { kind: "quiet"; quietMs: number }
  | null;

export const STREAM_QUIET_THRESHOLD_MS = 2500;

/**
 * Decide what the under-transcript activity line should say. Pure so the
 * suppression rules are testable: no line while a permission prompt is
 * waiting on the user (the prompt is the message) or while a tool card is
 * already showing "running…".
 */
export function resolveStreamActivity(args: {
  streaming: boolean;
  lastEventAt: number | null;
  hasAssistantContent: boolean;
  hasPendingPermission: boolean;
  hasRunningTool: boolean;
  now: number;
  quietThresholdMs?: number;
}): StreamActivity {
  const threshold = args.quietThresholdMs ?? STREAM_QUIET_THRESHOLD_MS;
  if (!args.streaming) return null;
  if (args.hasPendingPermission || args.hasRunningTool) return null;
  if (!args.hasAssistantContent) return { kind: "thinking" };
  if (args.lastEventAt == null) return null;
  const quietMs = args.now - args.lastEventAt;
  if (quietMs < threshold) return null;
  return { kind: "quiet", quietMs };
}
