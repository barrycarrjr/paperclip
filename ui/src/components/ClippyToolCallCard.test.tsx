// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClippyToolCallCard } from "./ClippyToolCallCard";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={typeof to === "string" ? to : ""} {...props}>
      {children}
    </a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(props: Parameters<typeof ClippyToolCallCard>[0]) {
  act(() => {
    root.render(<ClippyToolCallCard {...props} />);
  });
}

function summary(): string {
  return container.querySelector('[data-testid="tool-step-summary"]')?.textContent ?? "";
}

function chevron(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>("button[aria-expanded]");
  expect(button, "no details toggle").not.toBeNull();
  return button!;
}

async function expand() {
  await act(async () => {
    chevron().dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const CREATED = {
  name: "create_issue",
  input: { title: "Send the IRS letter", dueDate: "2026-10-16", priority: "high" },
  status: "completed" as const,
  result: { ok: true, data: { ok: true, identifier: "HQ-1", title: "Send the IRS letter", dueDate: "2026-10-16" } },
};

describe("ClippyToolCallCard", () => {
  it("collapses a finished step to one plain line, with the issue it made linked", () => {
    render(CREATED);

    expect(summary()).toBe("Created issue HQ-1 · Send the IRS letter");
    expect(container.querySelector('a[href="/issues/HQ-1"]')?.textContent).toBe("HQ-1");
    expect(container.querySelector('[aria-label="Done"]')).not.toBeNull();
    // None of the raw parameters or raw JSON on the face any more.
    expect(container.textContent).not.toContain('"ok"');
    expect(container.textContent).not.toContain("dueDate");
    expect(chevron().getAttribute("aria-expanded")).toBe("false");
  });

  it("opens the full parameters and result behind the chevron, and closes them again", async () => {
    render(CREATED);

    await expand();
    expect(chevron().getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("create_issue");
    expect(container.textContent).toContain('"dueDate": "2026-10-16"');
    expect(container.textContent).toContain('"identifier": "HQ-1"');

    await expand();
    expect(container.textContent).not.toContain("dueDate");
  });

  it("shows a running step as its action with the time so far, and keeps the read marker in the details", async () => {
    render({
      name: "list_issues",
      input: { status: "backlog" },
      status: "pending",
      mutating: false,
      startedAt: Date.now() - 4000,
    });

    expect(summary()).toBe("Look up issues…");
    expect(container.querySelector('[aria-label="Running"]')).not.toBeNull();
    expect(container.textContent).toContain("4s");
    expect(container.textContent).not.toContain("read");

    await expand();
    expect(container.innerHTML).toContain(">read<");
  });

  it("marks a step that changes things in its details", async () => {
    render({ name: "create_issue", input: {}, status: "pending", mutating: true });
    await expand();
    expect(container.textContent).toContain("does something real");
  });

  it("gives no read or write marker for plugin tools (the flag is untrustworthy there)", async () => {
    render({ name: "3cx-tools__pbx_click_to_call", input: { number: "555" }, status: "pending", mutating: false });
    await expand();
    expect(container.innerHTML).not.toContain(">read<");
    expect(container.textContent).not.toContain("does something real");
    expect(container.textContent).toContain("from 3cx-tools");
  });

  it("counts what a lookup found", () => {
    render({ name: "list_issues", input: {}, status: "completed", result: { ok: true, data: [{}, {}, {}] } });
    expect(summary()).toBe("Looked up issues · 3 found");
  });

  it("says plainly when a step failed, with the first line of why", () => {
    render({
      name: "create_issue",
      input: {},
      status: "completed",
      result: { ok: false, data: "Company not found\nstack trace here" },
    });
    expect(summary()).toBe("Could not create an issue · Company not found");
    expect(container.querySelector('[aria-label="Failed"]')).not.toBeNull();
    expect(container.textContent).not.toContain("stack trace");
  });

  it("says when the person said no", () => {
    render({ name: "create_issue", input: {}, status: "denied", result: { ok: false, data: "User denied this action." } });
    expect(summary()).toBe("Did not create an issue · you said no");
  });

  it("says 'no result' for a historical step with no outcome instead of claiming it runs", () => {
    render({ name: "get_issue", input: {}, status: "interrupted" });
    expect(summary()).toBe("Look up an issue · no result");
    expect(container.querySelector('[aria-label="Running"]')).toBeNull();
  });

  it("links a drafted step to its approval instead of showing a raw marker", () => {
    render({
      name: "email-tools__send_email",
      input: {},
      status: "completed",
      result: { ok: true, data: { drafted: true, approvalId: "ap-42" } },
    });
    expect(summary()).toContain("waiting for your approval");
    expect(container.querySelector('a[href="/approvals/ap-42"]')?.textContent).toBe("Open approval");
  });

  it("finds the approval in the marker text the server actually streams", () => {
    const marker = [
      "[paperclip:tool-draft] queued for human approval",
      "Tool: email-tools__send_email",
      "Approval ID: ap-77",
      "",
      "The user must approve this draft before it executes.",
    ].join("\n");
    render({ name: "email-tools__send_email", input: {}, status: "completed", result: { ok: true, data: marker } });
    expect(container.querySelector('a[href="/approvals/ap-77"]')).not.toBeNull();
    expect(container.textContent).not.toContain("[paperclip:tool-draft]");
  });
});
