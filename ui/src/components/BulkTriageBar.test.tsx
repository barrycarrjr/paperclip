// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BulkTriageBar, type BulkTriageAction } from "./BulkTriageBar";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("BulkTriageBar", () => {
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

  function render(node: React.ReactNode) {
    act(() => root.render(node));
  }

  function button(label: string): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === label,
    );
    if (!found) throw new Error(`no button labelled ${label}`);
    return found;
  }

  it("stays out of the way when nothing is selected", () => {
    render(<BulkTriageBar count={0} onAction={() => {}} onClear={() => {}} />);
    expect(container.textContent).toBe("");
  });

  it("says how many are selected and offers all five actions", () => {
    render(<BulkTriageBar count={13} onAction={() => {}} onClear={() => {}} />);
    expect(container.textContent).toContain("13 selected");
    for (const label of ["Mark pending", "Keep always", "Auto-noise and close", "Close", "Spam"]) {
      expect(button(label)).toBeTruthy();
    }
  });

  it("reports which action was asked for", () => {
    const onAction = vi.fn<(action: BulkTriageAction) => void>();
    render(<BulkTriageBar count={2} onAction={onAction} onClear={() => {}} />);

    act(() => button("Auto-noise and close").click());
    expect(onAction).toHaveBeenCalledWith("auto-noise");

    act(() => button("Spam").click());
    expect(onAction).toHaveBeenCalledWith("spam");
  });

  it("shows progress instead of the actions while a run is in flight", () => {
    // These runs take real seconds, so the bar has to keep saying what is
    // happening rather than going quiet until the end.
    render(
      <BulkTriageBar
        count={13}
        onAction={() => {}}
        onClear={() => {}}
        progress={{ action: "close", done: 4, total: 13 }}
      />,
    );
    expect(container.textContent).toContain("4 of 13 done");
    expect(() => button("Close")).toThrow();
  });

  it("offers a way to stop a run, but only while one is running", () => {
    const onCancel = vi.fn();
    render(
      <BulkTriageBar
        count={13}
        onAction={() => {}}
        onClear={() => {}}
        onCancel={onCancel}
        progress={{ action: "close", done: 1, total: 13 }}
      />,
    );
    act(() => button("Stop").click());
    expect(onCancel).toHaveBeenCalled();

    render(<BulkTriageBar count={13} onAction={() => {}} onClear={() => {}} onCancel={onCancel} />);
    expect(() => button("Stop")).toThrow();
  });

  it("holds the outcome after a run rather than flashing it", () => {
    render(
      <BulkTriageBar
        count={13}
        onAction={() => {}}
        onClear={() => {}}
        outcome={{ tone: "warning", message: "Closed 11. 2 failed." }}
      />,
    );
    expect(container.textContent).toContain("Closed 11. 2 failed.");
    expect(container.querySelector('[role="status"]')).toBeTruthy();
  });

  it("disables the actions and says why when they cannot run", () => {
    render(
      <BulkTriageBar
        count={3}
        onAction={() => {}}
        onClear={() => {}}
        disabledReason="Changes are turned off for this plugin."
      />,
    );
    expect(button("Close").disabled).toBe(true);
    expect(container.textContent).toContain("Changes are turned off for this plugin.");
  });

  it("clears the selection on request", () => {
    const onClear = vi.fn();
    render(<BulkTriageBar count={3} onAction={() => {}} onClear={onClear} />);
    act(() => button("Clear").click());
    expect(onClear).toHaveBeenCalled();
  });
});
