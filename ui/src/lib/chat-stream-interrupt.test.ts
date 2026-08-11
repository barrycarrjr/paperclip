import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  postChatMessageStream,
  STREAM_INTERRUPTED_CODE,
  type ChatStreamEvent,
} from "./chat-stream";

/**
 * A dropped connection used to be indistinguishable from a finished turn:
 * the SSE body simply ended, the reader reported done, and nothing was
 * reported to the user. These tests pin the difference — a stream that never
 * sent `done` or `error` must surface as an interruption.
 */

/** Build a Response whose body streams the given chunks then closes. */
function streamingResponse(chunks: string[], ok = true): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return { ok, body, status: ok ? 200 : 500 } as unknown as Response;
}

function sse(event: ChatStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("postChatMessageStream interruption reporting", () => {
  it("reports an interruption when the stream ends without a terminal event", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      streamingResponse([
        sse({ type: "message_started", messageId: "m1", role: "assistant" }),
        sse({ type: "text_delta", delta: "Half an ans" }),
        // …and the socket dies here. No `done`, no `error`.
      ]),
    ) as unknown as typeof fetch;

    const events: ChatStreamEvent[] = [];
    await postChatMessageStream("s1", "hi", (e) => events.push(e)).done;

    const last = events[events.length - 1];
    expect(last?.type).toBe("error");
    expect((last as { code?: string }).code).toBe(STREAM_INTERRUPTED_CODE);
    // The partial text still has to reach the caller — it is the evidence of
    // what did happen before the drop.
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
  });

  it("stays silent when the turn ended properly with done", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      streamingResponse([
        sse({ type: "text_delta", delta: "All done" }),
        sse({ type: "done", stopReason: "end_turn" }),
      ]),
    ) as unknown as typeof fetch;

    const events: ChatStreamEvent[] = [];
    await postChatMessageStream("s1", "hi", (e) => events.push(e)).done;

    expect(events.filter((e) => e.type === "error")).toHaveLength(0);
    expect(events[events.length - 1]?.type).toBe("done");
  });

  it("does not double-report when the turn ended with an error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      streamingResponse([sse({ type: "error", error: "provider exploded" })]),
    ) as unknown as typeof fetch;

    const events: ChatStreamEvent[] = [];
    await postChatMessageStream("s1", "hi", (e) => events.push(e)).done;

    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
    expect((events[0] as { code?: string }).code).toBeUndefined();
  });

  it("treats a deliberate Stop as a stop, not a dropped connection", async () => {
    // A never-ending body, so the only way out is the abort signal.
    globalThis.fetch = vi.fn().mockImplementation((_url, init) => {
      const signal = (init as RequestInit).signal as AbortSignal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener("abort", () => {
            controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        },
      });
      return Promise.resolve({ ok: true, body, status: 200 } as unknown as Response);
    }) as unknown as typeof fetch;

    const events: ChatStreamEvent[] = [];
    const handle = postChatMessageStream("s1", "hi", (e) => events.push(e));
    handle.abort();
    await handle.done;

    expect(events).toHaveLength(0);
  });
});
