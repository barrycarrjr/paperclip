// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClippyConversation } from "./ClippyConversation";

// Regression for the P2 Clippy audit: the composer's draft text and pending
// attachments are local state that used to survive a chat switch (this
// component never unmounted between sessions), so an unsent draft for one
// chat could get sent to a different one. Fixed by keying ClippyComposer on
// sessionId in ClippyConversation.tsx. This test deliberately does NOT mock
// ClippyComposer (unlike ClippyConversation.test.tsx) so the real remount
// behavior is what's under test.

vi.mock("../hooks/useChatSession", () => ({
  useChatSession: () => ({
    session: { id: "s1", title: "chat", permissionMode: "ask", effort: "auto", model: "claude-opus-5" },
    transcript: [],
    streaming: false,
    pendingPermissions: [],
    liveToolCalls: [],
    lastEventAt: null,
    send: vi.fn(),
    abortAndSend: vi.fn(),
    decidePermission: vi.fn(),
    patchSession: vi.fn(),
    abort: vi.fn(),
  }),
}));

vi.mock("./ClippyMessageList", () => ({ ClippyMessageList: () => <div data-testid="messages" /> }));

vi.mock("../api/chat", async () => {
  const actual = await vi.importActual<typeof import("../api/chat")>("../api/chat");
  return {
    ...actual,
    chatApi: {
      ...actual.chatApi,
      listModels: vi.fn().mockResolvedValue({ models: [] }),
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let queryClient: QueryClient;

async function renderWithSession(sessionId: string) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ClippyConversation sessionId={sessionId} />
      </QueryClientProvider>,
    );
  });
}

function textarea(): HTMLTextAreaElement {
  const el = container.querySelector("textarea");
  if (!el) throw new Error("composer textarea not found");
  return el as HTMLTextAreaElement;
}

describe("ClippyConversation session switch (real ClippyComposer)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("clears an unsent draft when the active chat session changes", async () => {
    await renderWithSession("session-a");

    // A plain `input.value = ...` doesn't trigger React's onChange — React
    // tracks a hidden "last value" via the native setter, so the change has
    // to go through that setter for the dispatched event to be noticed.
    const nativeValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    act(() => {
      const input = textarea();
      nativeValueSetter.call(input, "an unsent draft for session A");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {});
    expect(textarea().value).toBe("an unsent draft for session A");

    await renderWithSession("session-b");

    expect(textarea().value).toBe("");
  });
});
