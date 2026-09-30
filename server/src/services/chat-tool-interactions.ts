import { randomUUID } from "node:crypto";
import type { StreamEvent } from "./chat.js";
import { chatPermissions, CHAT_PERMISSION_TTL_MS } from "./chat-permissions.js";
import { conflict } from "../errors.js";

// One live conversation owns its prompts. Both native and MCP tools use it.
const streams = new Map<string, (event: StreamEvent) => void>();

export function emitChatToolEvent(sessionId: string, event: StreamEvent) {
  streams.get(sessionId)?.(event);
}

export function registerChatToolInteractions(sessionId: string, emit: (event: StreamEvent) => void) {
  if (streams.has(sessionId)) throw conflict("This conversation already has a running turn");
  streams.set(sessionId, emit);
  return () => {
    if (streams.get(sessionId) === emit) {
      streams.delete(sessionId);
      chatPermissions.cancelSession(sessionId);
    }
  };
}

export async function requestChatToolConfirmation(sessionId: string | undefined, name: string, input: unknown) {
  const emit = sessionId ? streams.get(sessionId) : undefined;
  if (!sessionId || !emit) return false;
  const toolUseId = `confirm-${randomUUID()}`;
  const decision = chatPermissions.await(toolUseId, sessionId);
  emit({ type: "tool_use_block", toolUseId, name, input, mutating: true });
  emit({ type: "permission_required", toolUseId, name, input, ttlMs: CHAT_PERMISSION_TTL_MS });
  const approved = (await decision) === "approve";
  if (streams.get(sessionId) !== emit) return false;
  emit({ type: "tool_result_block", toolUseId, ok: approved,
    result: { confirmation: approved ? "approved" : "denied" } });
  return approved;
}
