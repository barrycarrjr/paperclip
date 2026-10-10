// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSession } from "../api/chat";
import { ClippyChatRow } from "./ClippyChatRow";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const TWO_HOURS = 2 * 60 * 60 * 1000;

function chat(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "chat-1",
    boardUserId: "user-1",
    companyId: "company-1",
    title: "Remind me to send the IRS letter",
    model: "adapter:claude_local:claude-sonnet-5-5",
    mode: "agent",
    permissionMode: "bypass",
    effort: "auto",
    pageContext: null,
    archivedAt: null,
    createdAt: new Date(Date.now() - TWO_HOURS).toISOString(),
    updatedAt: new Date(Date.now() - TWO_HOURS).toISOString(),
    ...overrides,
  };
}

let container: HTMLUListElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("ul");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(props: Partial<Parameters<typeof ClippyChatRow>[0]> = {}) {
  const handlers = {
    onSelect: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
  };
  act(() => {
    root.render(
      <ClippyChatRow
        session={chat()}
        company={{ name: "HQ", brandColor: "#0055ff" }}
        active={false}
        {...handlers}
        {...props}
      />,
    );
  });
  return handlers;
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) =>
      candidate.getAttribute("aria-label") === label ||
      candidate.textContent === label ||
      // The row itself is named by the chat's title.
      candidate.getAttribute("title") === label,
  );
  expect(found, `no "${label}" button`).toBeDefined();
  return found!;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function press(element: HTMLElement, key: string) {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

describe("ClippyChatRow", () => {
  it("shows the chat's company and when it was last used, not its model id", () => {
    render();
    expect(container.textContent).toContain("Remind me to send the IRS letter");
    expect(container.textContent).toContain("HQ · 2h ago");
    expect(container.textContent).not.toContain("claude");
    expect(container.textContent).not.toContain("adapter:");
  });

  it("leaves the company out for a chat that belongs to none, and marks an archived one", () => {
    render({ company: null, session: chat({ companyId: null, archivedAt: new Date().toISOString() }) });
    expect(container.textContent).toContain("Archived · 2h ago");
  });

  it("opens the chat when its row is clicked", async () => {
    const { onSelect } = render();
    await click(button("Remind me to send the IRS letter"));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("renames in place: Enter saves the new title", async () => {
    const { onRename } = render();
    await click(button('Rename "Remind me to send the IRS letter"'));
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Chat name"]');
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "IRS letter");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press(input!, "Enter");
    expect(onRename).toHaveBeenCalledWith("IRS letter");
  });

  it("asks in the row before deleting, and Cancel keeps the chat", async () => {
    const { onDelete } = render();
    await click(button('Delete "Remind me to send the IRS letter"'));
    expect(container.textContent).toContain('Delete "Remind me to send the IRS letter"?');
    // Focus lands on the safe choice.
    expect(document.activeElement?.textContent).toBe("Cancel");

    await click(button("Cancel"));
    expect(onDelete).not.toHaveBeenCalled();
    expect(container.textContent).toContain("HQ · 2h ago");

    await click(button('Delete "Remind me to send the IRS letter"'));
    await click(button("Delete"));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("offers archive only where archived chats are listed", () => {
    render();
    expect(container.querySelector('button[aria-label^="Archive"]')).toBeNull();
    render({ onArchiveToggle: vi.fn() });
    expect(container.querySelector('button[aria-label^="Archive"]')).not.toBeNull();
  });
});
