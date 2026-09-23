// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ROW_WITH_HOVER_TOOLBAR, RowHoverToolbar } from "./RowHoverToolbar";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(node: React.ReactNode): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

describe("RowHoverToolbar", () => {
  it("floats over the row instead of taking width from its text", () => {
    const el = render(
      <RowHoverToolbar>
        <button type="button">Delete</button>
      </RowHoverToolbar>,
    );
    const bar = el.firstElementChild as HTMLElement;
    expect(bar.className).toContain("absolute");
    expect(bar.className).not.toContain("shrink-0");
  });

  it("reveals on its own row's hover or keyboard focus, never on a hovered ancestor list", () => {
    // A plain group-hover fires for any hovered `group` ancestor, which is how
    // pointing at the list lit up every row's buttons at once.
    const el = render(<RowHoverToolbar>x</RowHoverToolbar>);
    const cls = (el.firstElementChild as HTMLElement).className;
    expect(cls).toContain("opacity-0");
    expect(cls).toContain("pointer-events-none");
    expect(cls).toContain("group-hover/row:opacity-100");
    expect(cls).toContain("group-has-[:focus-visible]/row:opacity-100");
    expect(cls).not.toMatch(/(^|\s)group-hover:opacity-100/);
    // Plain focus-within also matches a button focused by a mouse click,
    // which left the toolbar stuck over the row after the pointer moved on.
    expect(cls).not.toContain("focus-within");
    expect(ROW_WITH_HOVER_TOOLBAR.split(" ")).toEqual(expect.arrayContaining(["relative", "group/row"]));
  });

  it("stays showing while forced, e.g. with its menu open", () => {
    const el = render(<RowHoverToolbar forceVisible>x</RowHoverToolbar>);
    const cls = (el.firstElementChild as HTMLElement).className;
    expect(cls).toContain("opacity-100");
    expect(cls).not.toContain("opacity-0");
    expect(cls).not.toContain("pointer-events-none");
  });

  it("keeps a click on a button from also opening the row", () => {
    const onRowClick = vi.fn();
    const onButton = vi.fn();
    const el = render(
      <div onClick={onRowClick}>
        <RowHoverToolbar>
          <button type="button" onClick={onButton}>
            Delete
          </button>
        </RowHoverToolbar>
      </div>,
    );
    act(() => {
      el.querySelector("button")!.click();
    });
    expect(onButton).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
  });
});
