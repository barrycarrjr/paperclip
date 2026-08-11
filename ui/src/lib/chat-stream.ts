import type { ChatSession } from "../api/chat";

export type ChatStreamEvent =
  | { type: "session_state"; session: ChatSession }
  | { type: "message_started"; messageId: string; role: "assistant" }
  | { type: "text_delta"; delta: string }
  | {
      type: "tool_use_block";
      toolUseId: string;
      name: string;
      input: unknown;
      mutating: boolean;
    }
  | {
      type: "permission_required";
      toolUseId: string;
      name: string;
      input: unknown;
      /** How long the server waits before auto-denying, for the countdown. */
      ttlMs?: number;
    }
  | { type: "tool_result_block"; toolUseId: string; ok: boolean; result: unknown }
  | { type: "message_completed"; messageId: string }
  | { type: "done"; stopReason: string }
  | { type: "error"; error: string; code?: string }
  | { type: "ping" };

export interface StreamHandle {
  done: Promise<void>;
  abort: () => void;
}

/**
 * Error code for "the SSE stream ended without ever sending `done` or
 * `error`". That means the connection went away mid-turn — a proxy idle
 * timeout, the machine sleeping, a wifi blip, a server restart.
 *
 * This used to be invisible: the reader simply reported end-of-stream, the
 * loop broke, and the turn stopped with nothing on screen. The user saw the
 * assistant go quiet and had no way to tell a dropped connection from a
 * model that had finished. Work was lost with no error anywhere.
 */
export const STREAM_INTERRUPTED_CODE = "stream_interrupted";

const STREAM_INTERRUPTED_MESSAGE =
  "The connection dropped before this turn finished. Anything above arrived " +
  "before the drop; anything the assistant was still doing did not complete. " +
  "Send the message again to retry.";

export function postChatMessageStream(
  sessionId: string,
  text: string,
  onEvent: (event: ChatStreamEvent) => void,
  attachmentIds: string[] = [],
): StreamHandle {
  const controller = new AbortController();
  const done = (async () => {
    let res: Response;
    try {
      res = await fetch(`/api/chat/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ text, attachmentIds }),
        credentials: "include",
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      onEvent({ type: "error", error: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        /* ignore */
      }
      const errMsg =
        (body as { error?: string } | null)?.error ?? `Request failed: ${res.status}`;
      const code = (body as { code?: string } | null)?.code;
      onEvent({ type: "error", error: errMsg, code });
      return;
    }
    if (!res.body) {
      onEvent({ type: "error", error: "No response body for SSE stream" });
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    // Whether the server ever sent a terminal event. If the stream ends and
    // this is still false, the connection died rather than the turn ending.
    let sawTerminalEvent = false;
    try {
      while (true) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buf += decoder.decode(value, { stream: true });
        let sepIdx;
        while ((sepIdx = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, sepIdx);
          buf = buf.slice(sepIdx + 2);
          // Parse SSE block: lines of `event: x` and `data: y`
          let dataLine: string | null = null;
          for (const line of block.split("\n")) {
            if (line.startsWith("data:")) {
              dataLine = (dataLine ?? "") + line.slice(5).trimStart();
            }
          }
          if (!dataLine) continue;
          try {
            const parsed = JSON.parse(dataLine) as ChatStreamEvent;
            if (parsed.type === "done" || parsed.type === "error") {
              sawTerminalEvent = true;
            }
            onEvent(parsed);
          } catch {
            /* skip malformed event */
          }
        }
      }
      // Clean end-of-stream, but the server never said the turn was over.
      // Report it — the alternative is the silent stop this whole code path
      // exists to eliminate. A deliberate Stop takes the AbortError branch
      // below instead, so this only fires on a genuine drop.
      if (!sawTerminalEvent && !controller.signal.aborted) {
        onEvent({
          type: "error",
          error: STREAM_INTERRUPTED_MESSAGE,
          code: STREAM_INTERRUPTED_CODE,
        });
      }
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      // A read that throws mid-stream is the same failure wearing a different
      // hat — the socket died. Say so in the same words rather than surfacing
      // a raw browser network message the user can't act on.
      if (!sawTerminalEvent) {
        onEvent({
          type: "error",
          error: STREAM_INTERRUPTED_MESSAGE,
          code: STREAM_INTERRUPTED_CODE,
        });
        return;
      }
      onEvent({ type: "error", error: err instanceof Error ? err.message : String(err) });
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  })();

  return {
    done,
    abort: () => controller.abort(),
  };
}
