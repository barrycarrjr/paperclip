// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScrollArea } from "./scroll-area";
import { SCROLL_AREA_FITS_COLUMN_CLASS } from "@/lib/narrow-layout";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * There is no layout engine here, so none of this can measure a width. What it
 * can do is prove the rule reaches the one element it has to reach.
 *
 * Radix wraps whatever you put in a scrolling column in a box of its own, sets
 * that box to `display: table` in a style attribute, and a table box grows to
 * fit its widest content. So a row asking for the full width of that box gets
 * the width of the widest row instead of the width of the column, and a row
 * asking to cut its text short with three dots never has to. That is why every
 * mailbox and folder row on the Email page ran past the edge of the column
 * that clips it. The real widths are measured in a browser; what is checked
 * here is that the component still carries the rule that fixes it, and that
 * Radix has not moved the box it applies to.
 */
describe("the scrolling column keeps its contents to its own width", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render() {
    act(() => {
      root.render(
        <ScrollArea>
          <div data-testid="row">A folder with a very long name indeed</div>
        </ScrollArea>,
      );
    });
    const viewport = container.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    expect(viewport).not.toBeNull();
    return viewport!;
  }

  it("carries the rule on the scrolling area itself", () => {
    expect(render().className).toContain(SCROLL_AREA_FITS_COLUMN_CLASS);
  });

  it("keeps the classes it already had", () => {
    // The rule was added to a className that was a plain string, so this is
    // here to catch the merge dropping the rest of it.
    expect(render().className).toContain("w-full");
  });

  it("still wraps its contents in exactly one box, which is what the rule aims at", () => {
    const viewport = render();
    const children = Array.from(viewport.children);
    expect(children).toHaveLength(1);
    expect(children[0]!.tagName).toBe("DIV");
    // If Radix ever stops doing this, the rule quietly aims at nothing.
    expect(children[0]!.getAttribute("style")).toContain("display: table");
    expect(children[0]!.querySelector('[data-testid="row"]')).not.toBeNull();
  });
});
