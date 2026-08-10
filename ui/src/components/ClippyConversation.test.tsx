// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClippyConversation } from "./ClippyConversation";

vi.mock("../hooks/useChatSession", () => ({
  useChatSession: () => ({
    session: { id: "s1", title: "why am I having so much trouble with mme-261", permissionMode: "ask", effort: "auto", model: "claude-opus-5" },
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
vi.mock("./ClippyComposer", () => ({ ClippyComposer: () => <div data-testid="composer" /> }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render(props: Parameters<typeof ClippyConversation>[0]) {
  await act(async () => {
    root.render(<ClippyConversation {...props} />);
  });
}

function listButton(): HTMLElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === "Show the chat list",
  );
}

describe("ClippyConversation", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  // On a phone the chat list is hidden so the conversation gets the whole
  // screen, which leaves no way back to it without this.
  it("offers a way back to the chat list, on small screens only", async () => {
    const onOpenSessionList = vi.fn();
    await render({ sessionId: "s1", onOpenSessionList });

    const button = listButton();
    expect(button).toBeDefined();
    expect(button?.className).toContain("md:hidden");

    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onOpenSessionList).toHaveBeenCalledTimes(1);
  });

  it("shows no such button where the list is always on screen", async () => {
    await render({ sessionId: "s1" });

    expect(listButton()).toBeUndefined();
  });

  it("keeps a long chat title from pushing the header wider than the screen", async () => {
    await render({ sessionId: "s1", onOpenSessionList: vi.fn() });

    const title = [...container.querySelectorAll("span")].find((span) =>
      span.textContent?.includes("mme-261"),
    );
    expect(title?.className).toContain("truncate");
    expect(title?.className).toContain("min-w-0");
  });

  it("offers the list from the empty state too, so a phone is never stuck", async () => {
    const onOpenSessionList = vi.fn();
    await render({ sessionId: null, onOpenSessionList });

    const button = [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes("Show chats"),
    );
    expect(button?.className).toContain("md:hidden");
  });
});
