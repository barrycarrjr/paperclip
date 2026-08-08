// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HorizontalScroller } from "./HorizontalScroller";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * jsdom does no layout, so every element reports zero width. These stubs stand
 * in for the one measurement the component actually depends on: how much
 * content sits outside the visible box.
 */
function stubScrollMetrics(scrollWidth: number, clientWidth: number) {
  const previous = {
    scrollWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth"),
    clientWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth"),
  };

  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get() {
      return scrollWidth;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return clientWidth;
    },
  });

  return () => {
    for (const key of ["scrollWidth", "clientWidth"] as const) {
      const descriptor = previous[key];
      if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
    }
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let restoreMetrics: (() => void) | null = null;

function render(ui: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(ui);
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
  restoreMetrics?.();
  restoreMetrics = null;
});

function scrollButtons(el: HTMLElement) {
  return {
    left: el.querySelector<HTMLButtonElement>('button[aria-label="Scroll left"]'),
    right: el.querySelector<HTMLButtonElement>('button[aria-label="Scroll right"]'),
  };
}

describe("HorizontalScroller", () => {
  it("shows no nudge buttons when the content fits", () => {
    restoreMetrics = stubScrollMetrics(500, 500);
    const el = render(
      <HorizontalScroller label="Board columns">
        <div>columns</div>
      </HorizontalScroller>,
    );

    const buttons = scrollButtons(el);
    expect(buttons.left).toBeNull();
    expect(buttons.right).toBeNull();
  });

  it("offers a right nudge when content continues past the right edge", () => {
    restoreMetrics = stubScrollMetrics(1800, 700);
    const el = render(
      <HorizontalScroller label="Board columns">
        <div>columns</div>
      </HorizontalScroller>,
    );

    const buttons = scrollButtons(el);
    expect(buttons.right).not.toBeNull();
    // Nothing is hidden to the left until the strip has been scrolled.
    expect(buttons.left).toBeNull();
  });

  it("offers a left nudge once the strip has been scrolled away from the start", () => {
    restoreMetrics = stubScrollMetrics(1800, 700);
    const el = render(
      <HorizontalScroller label="Board columns">
        <div>columns</div>
      </HorizontalScroller>,
    );

    const strip = el.querySelector<HTMLDivElement>('[role="group"]')!;
    strip.scrollLeft = 400;
    act(() => {
      strip.dispatchEvent(new Event("scroll"));
    });

    const buttons = scrollButtons(el);
    expect(buttons.left).not.toBeNull();
    expect(buttons.right).not.toBeNull();
  });

  it("drops the right nudge at the end of the strip", () => {
    restoreMetrics = stubScrollMetrics(1800, 700);
    const el = render(
      <HorizontalScroller label="Board columns">
        <div>columns</div>
      </HorizontalScroller>,
    );

    const strip = el.querySelector<HTMLDivElement>('[role="group"]')!;
    strip.scrollLeft = 1100; // scrollWidth - clientWidth
    act(() => {
      strip.dispatchEvent(new Event("scroll"));
    });

    const buttons = scrollButtons(el);
    expect(buttons.right).toBeNull();
    expect(buttons.left).not.toBeNull();
  });

  it("scrolls by most of a screenful when a nudge button is pressed", () => {
    restoreMetrics = stubScrollMetrics(1800, 700);
    const el = render(
      <HorizontalScroller label="Board columns">
        <div>columns</div>
      </HorizontalScroller>,
    );

    const strip = el.querySelector<HTMLDivElement>('[role="group"]')!;
    const scrollBy = vi.fn();
    strip.scrollBy = scrollBy;

    act(() => {
      scrollButtons(el).right!.click();
    });

    expect(scrollBy).toHaveBeenCalledWith({ left: 700 * 0.8, behavior: "smooth" });
  });

  it("keeps the strip reachable from the keyboard and names it for screen readers", () => {
    restoreMetrics = stubScrollMetrics(1800, 700);
    const el = render(
      <HorizontalScroller label="Board columns">
        <div>columns</div>
      </HorizontalScroller>,
    );

    const strip = el.querySelector<HTMLDivElement>('[role="group"]')!;
    expect(strip.getAttribute("tabindex")).toBe("0");
    expect(strip.getAttribute("aria-label")).toBe("Board columns");
    expect(el.textContent).toContain("This list scrolls sideways for more columns.");
  });
});
