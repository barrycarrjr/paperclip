// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { MailHeader } from "../api/emailTools";
import { MessageRow } from "./PortfolioEmail";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const msg: MailHeader = {
  uid: 42,
  messageId: null,
  from: "Someone <someone@example.com>",
  subject: "Quote for business cards",
  date: "2026-09-23T12:00:00Z",
  snippet: "",
  unseen: false,
};

function rowProps() {
  return {
    msg,
    messages: [msg],
    messagesLoading: false,
    messagesError: null,
    showAll: false,
    groupBySender: false,
    autoTriageSet: new Set<string>(),
    keepAlwaysSet: new Set<string>(),
    senderMatchesPattern: () => false,
    markRead: vi.fn(),
    markReadPendingUid: null,
    markUnread: vi.fn(),
    markUnreadPendingUid: null,
    keepAlways: vi.fn(),
    keepAlwaysPendingUid: null,
    autoTriage: vi.fn(),
    autoTriagePendingUid: null,
    deleteMsg: vi.fn(),
    deletePendingUid: null,
    onOpenMessage: vi.fn(),
    onPopoutMessage: vi.fn(),
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

describe("a Portfolio Email message row", () => {
  it("keeps its toolbar showing while the More actions menu is open", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <TooltipProvider>
          <MessageRow {...rowProps()} />
        </TooltipProvider>,
      );
    });

    const more = container.querySelector('button[title="More actions"]')!;
    const toolbar = more.parentElement!;
    // Hidden until the row is pointed at.
    expect(toolbar.classList.contains("opacity-0")).toBe(true);

    // Moving into the open menu takes the pointer off the row, which hid the
    // toolbar and the menu's own button with it.
    await act(async () => {
      more.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    });
    expect(document.body.textContent).toContain("Hand off to agent");
    expect(toolbar.classList.contains("opacity-100")).toBe(true);
    expect(toolbar.classList.contains("opacity-0")).toBe(false);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.body.textContent).not.toContain("Hand off to agent");
    expect(toolbar.classList.contains("opacity-0")).toBe(true);
  });
});
