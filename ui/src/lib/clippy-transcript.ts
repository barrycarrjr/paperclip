import type { ChatContentBlock, ChatMessage } from "../api/chat";
import type { ClippyTranscriptEntry } from "./clippy-stream-reducer";

/**
 * Merge the persisted transcript with the in-flight streamed entry.
 *
 * The server persists the assistant message (and fires the refetch) BEFORE
 * it streams the tool_use blocks, so the streamed pending entry can hold
 * tool_use blocks that are already in a persisted message. Without deduping,
 * every tool call — including a waiting permission prompt — renders twice
 * from refetch-land until the turn ends.
 */
export function mergeTranscript(
  messages: ChatMessage[],
  pendingAssistant: ClippyTranscriptEntry | null,
): ClippyTranscriptEntry[] {
  const transcript: ClippyTranscriptEntry[] = messages.map((m) => ({
    id: m.id,
    role: m.role,
    blocks: m.content,
  }));
  if (!pendingAssistant) return transcript;
  if (messages.some((m) => m.id === pendingAssistant.id)) return transcript;

  const persistedToolUseIds = new Set(
    messages.flatMap((m) =>
      m.content
        .filter((b): b is ChatContentBlock & { type: "tool_use" } => b.type === "tool_use")
        .map((b) => b.id),
    ),
  );
  const blocks = pendingAssistant.blocks.filter(
    (b) => b.type !== "tool_use" || !persistedToolUseIds.has(b.id),
  );
  // Keep the genuinely-empty entry (the streaming "…" placeholder), but drop
  // an entry whose every block was a duplicate of persisted content.
  if (blocks.length === 0 && pendingAssistant.blocks.length > 0) return transcript;
  transcript.push({ ...pendingAssistant, blocks });
  return transcript;
}
