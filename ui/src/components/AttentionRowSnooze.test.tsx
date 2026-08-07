// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionRow as AttentionRowData } from "@paperclipai/shared";
import { AttentionRow } from "./AttentionRow";

/**
 * The sibling AttentionRow.test.tsx renders to a static string, which cannot
 * click anything. The snooze control needs a real DOM, so it lives here.
 */

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={typeof to === "string" ? to : ""} {...props}>
      {children}
    </a>
  ),
}));

// The menu is a portal with its own focus management; flatten it so the items
// are simply present in the DOM.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect: () => void }) => (
    <button type="button" onClick={onSelect}>{children}</button>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-08-06T14:00:00").getTime();

function row(overrides: Partial<AttentionRowData> = {}): AttentionRowData {
  return {
    key: "question:iss-1",
    kind: "question",
    companyId: "c-1",
    title: "Which supplier?",
    detail: null,
    askedBy: null,
    blocking: "waiting",
    blockedSinceMs: NOW,
    count: 1,
    consequence: null,
    deadlineAtMs: null,
    deadlineOutcome: null,
    href: "/issues/PER-10",
    createdAtMs: NOW,
    updatedAtMs: NOW,
    ...overrides,
  };
}

describe("AttentionRow snooze control", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(node: ReactNode) {
    act(() => root.render(node));
  }

  function button(label: string): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === label,
    );
    if (!found) throw new Error(`no button labelled ${label}`);
    return found;
  }

  it("shows no snooze control on a surface that only displays rows", () => {
    render(<AttentionRow row={row()} nowMs={NOW} />);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("offers the presets when snoozing is possible", () => {
    render(<AttentionRow row={row()} nowMs={NOW} onSnooze={() => {}} />);
    for (const label of [
      "For an hour",
      "For three hours",
      "Until tomorrow morning",
      "Until Monday morning",
    ]) {
      expect(button(label)).toBeTruthy();
    }
  });

  it("hands back the row and a moment in the future", () => {
    const onSnooze = vi.fn();
    const before = Date.now();
    render(<AttentionRow row={row()} nowMs={NOW} onSnooze={onSnooze} />);

    act(() => button("For an hour").click());

    expect(onSnooze).toHaveBeenCalledTimes(1);
    const [snoozedRow, until] = onSnooze.mock.calls[0]!;
    expect(snoozedRow.key).toBe("question:iss-1");
    expect(until.getTime()).toBeGreaterThanOrEqual(before + 60 * 60_000);
  });

  it("measures from the click, not from the stale display clock", () => {
    // nowMs is the clock the page rendered with. A list that keeps returning
    // identical rows does not re-render, so nowMs can sit hours behind. If the
    // deadline were measured from it, "in an hour" could land in the past and
    // the server would reject it.
    const onSnooze = vi.fn();
    const staleClock = Date.now() - 6 * 60 * 60_000;
    render(<AttentionRow row={row()} nowMs={staleClock} onSnooze={onSnooze} />);

    act(() => button("For an hour").click());

    const until: Date = onSnooze.mock.calls[0]![1];
    expect(until.getTime()).toBeGreaterThan(Date.now());
  });

  it("keeps the row's own link working alongside the control", () => {
    render(<AttentionRow row={row()} nowMs={NOW} onSnooze={() => {}} />);
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/issues/PER-10");
  });

  it("keeps the control visible without hovering", () => {
    // It used to be opacity-0 until the row was hovered, so on a phone, and in
    // any screenshot, there was no visible way to put a row away at all.
    render(<AttentionRow row={row()} nowMs={NOW} onSnooze={() => {}} />);
    const trigger = container.querySelector("button");
    expect(trigger?.className).not.toContain("opacity-0");
  });
});

describe("AttentionRow dismiss control", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(node: ReactNode) {
    act(() => root.render(node));
  }

  function buttonContaining(text: string): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes(text),
    );
    if (!found) throw new Error(`no button containing ${text}`);
    return found;
  }

  const failedRun = row({
    key: "run-cause:agent-1:claude_auth_required",
    kind: "run_failure",
    title: "Steward cannot sign in to Claude Code",
    href: "/agents/agent-1/runs/run-9",
  });

  it("offers no dismiss where the surface cannot act on one", () => {
    render(<AttentionRow row={failedRun} nowMs={NOW} onSnooze={() => {}} />);
    expect(container.textContent).not.toContain("Seen it");
  });

  it("says what dismissing a failed run actually means", () => {
    // Plain "Dismiss" next to a failure could be read as cancelling the work or
    // stopping the agent. It does neither.
    render(<AttentionRow row={failedRun} nowMs={NOW} onDismiss={() => {}} />);
    expect(buttonContaining("Seen it, not retrying")).toBeTruthy();
  });

  it("hands the whole row back so the caller can key the dismissal correctly", () => {
    const onDismiss = vi.fn();
    render(<AttentionRow row={failedRun} nowMs={NOW} onDismiss={onDismiss} />);

    act(() => buttonContaining("Seen it, not retrying").click());

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss.mock.calls[0]![0].key).toBe("run-cause:agent-1:claude_auth_required");
  });

  it("carries both actions in one menu", () => {
    render(<AttentionRow row={failedRun} nowMs={NOW} onSnooze={() => {}} onDismiss={() => {}} />);
    expect(buttonContaining("Seen it, not retrying")).toBeTruthy();
    expect(buttonContaining("For an hour")).toBeTruthy();
  });

  it("still follows the row's link rather than dismissing on a plain tap", () => {
    render(<AttentionRow row={failedRun} nowMs={NOW} onDismiss={() => {}} />);
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/agents/agent-1/runs/run-9");
  });
});
