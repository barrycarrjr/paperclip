// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { MailHeader } from "../api/emailTools";
import { MessageRow, SenderGroup } from "./PortfolioEmail";

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
    snooze: vi.fn(),
    snoozePendingUid: null,
    snoozeGroup: vi.fn(),
    snoozeGroupPendingSender: null,
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

  it("offers snooze from its hover buttons and snoozes that email", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const props = rowProps();
    act(() => {
      root!.render(
        <TooltipProvider>
          <MessageRow {...props} />
        </TooltipProvider>,
      );
    });

    const snoozeButton = container.querySelector('button[aria-label="Snooze"]')!;
    expect(snoozeButton).not.toBeNull();
    const toolbar = snoozeButton.parentElement!;
    // It sits between Keep always and Auto-triage.
    const titles = Array.from(toolbar.querySelectorAll("button")).map(
      (b) => b.getAttribute("aria-label") ?? b.getAttribute("title"),
    );
    expect(titles.indexOf("Snooze")).toBe(titles.indexOf("Keep always") + 1);
    expect(titles.indexOf("Auto-triage")).toBe(titles.indexOf("Snooze") + 1);

    await act(async () => {
      snoozeButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    });
    expect(document.body.textContent).toContain("Snooze until...");
    expect(document.body.textContent).toContain("Pick date & time");
    // The toolbar stays up while the pointer is in the menu.
    expect(toolbar.classList.contains("opacity-100")).toBe(true);

    const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
    const first = items[0] as HTMLElement;
    await act(async () => {
      first.click();
    });
    expect(props.snooze).toHaveBeenCalledTimes(1);
    const [snoozedMsg, until] = (props.snooze as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(snoozedMsg).toBe(msg);
    expect(until).toBeInstanceOf(Date);
    expect((until as Date).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("a Portfolio Email sender group", () => {
  it("snoozes every email from that sender at once", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const second: MailHeader = { ...msg, uid: 43, subject: "Second quote" };
    const props = rowProps();
    act(() => {
      root!.render(
        <TooltipProvider>
          <SenderGroup {...props} sender="someone@example.com" msgs={[msg, second]} />
        </TooltipProvider>,
      );
    });

    // The header's snooze comes first; each row below has its own.
    const headerSnooze = container.querySelector('button[aria-label="Snooze"]')!;
    const headerButtons = Array.from(headerSnooze.parentElement!.querySelectorAll("button")).map(
      (b) => b.getAttribute("aria-label"),
    );
    expect(headerButtons.indexOf("Snooze")).toBe(headerButtons.indexOf("Keep always") + 1);

    await act(async () => {
      headerSnooze.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    });
    const first = document.querySelector('[role="menuitem"]') as HTMLElement;
    await act(async () => {
      first.click();
    });

    expect(props.snoozeGroup).toHaveBeenCalledTimes(1);
    const [sender, msgs, until] = (props.snoozeGroup as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(sender).toBe("someone@example.com");
    expect(msgs).toEqual([msg, second]);
    expect((until as Date).getTime()).toBeGreaterThan(Date.now());
    expect(props.snooze).not.toHaveBeenCalled();
  });
});
