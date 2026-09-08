// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailSelectionBar } from "./EmailSelectionBar";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const noop = () => {};

function props(over: Partial<Parameters<typeof EmailSelectionBar>[0]> = {}) {
  return {
    count: 2,
    selectAllState: "some" as const,
    onSelectVisible: noop,
    onMarkRead: noop,
    onMove: noop,
    folders: ["Archive", "Receipts"],
    onDone: noop,
    ...over,
  };
}

function render(over: Partial<Parameters<typeof EmailSelectionBar>[0]> = {}) {
  act(() => root.render(<EmailSelectionBar {...props(over)} />));
}

function button(text: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes(text),
  );
  if (!match) throw new Error(`No button containing "${text}". Saw: ${container.textContent}`);
  return match as HTMLButtonElement;
}

function click(text: string) {
  act(() => button(text).dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("the bar above the mail list", () => {
  it("says how many are ticked and offers the two actions", () => {
    render();
    expect(container.textContent).toContain("2 selected");
    expect(button("Mark read")).toBeTruthy();
    expect(button("Move selected")).toBeTruthy();
  });

  it("offers no way to delete mail", () => {
    render();
    const text = (container.textContent ?? "").toLowerCase();
    expect(text).not.toContain("delete");
    expect(text).not.toContain("trash");
  });

  it("offers to select every message on screen, and to clear once they all are", () => {
    render();
    expect(container.textContent).toContain("Select visible messages");
    render({ selectAllState: "all" });
    expect(container.textContent).toContain("Clear selection");
  });

  it("does nothing to any message until a button is pressed", () => {
    const onMarkRead = vi.fn();
    const onMove = vi.fn();
    render({ onMarkRead, onMove });
    expect(onMarkRead).not.toHaveBeenCalled();
    expect(onMove).not.toHaveBeenCalled();
    click("Mark read");
    expect(onMarkRead).toHaveBeenCalledTimes(1);
  });

  it("will not act with nothing ticked", () => {
    render({ count: 0 });
    expect(button("Mark read").disabled).toBe(true);
    expect(button("Move selected").disabled).toBe(true);
  });

  it("stays on screen with nothing ticked, because that is where selecting starts", () => {
    render({ count: 0 });
    expect(container.textContent).toContain("0 selected");
    expect(container.textContent).toContain("Select visible messages");
  });

  it("counts down while a run is going, and offers a way to stop", () => {
    const onCancel = vi.fn();
    render({ progress: { action: "move", done: 1, total: 4 }, onCancel });
    expect(container.textContent).toContain("1 of 4 done");
    expect(container.textContent).toContain("4 selected");
    click("Stop");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("holds a part-finished result on screen rather than flashing it", () => {
    render({ outcome: { tone: "warning", message: "Moved 2. 1 failed." } });
    const said = container.querySelector('[role="status"]');
    expect(said?.textContent).toBe("Moved 2. 1 failed.");
    expect(said?.className).toContain("amber");
  });

  it("shows a failure in the failure colour, not the success one", () => {
    render({ outcome: { tone: "error", message: "None of the 3 selected could be moved." } });
    expect(container.querySelector('[role="status"]')?.className).toContain("red");
  });

  it("leaves select mode when Done is pressed", () => {
    const onDone = vi.fn();
    render({ onDone });
    click("Done");
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
