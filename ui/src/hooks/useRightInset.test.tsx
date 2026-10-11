// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RIGHT_INSET_PROPERTY } from "../lib/narrow-layout";
import { useRightInsetRef } from "./useRightInset";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Row({ shown }: { shown: boolean }) {
  const ref = useRightInsetRef();
  return shown ? <div data-testid="row" ref={ref} /> : null;
}

describe("useRightInsetRef", () => {
  let container: HTMLDivElement;
  let rowRight = 340;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    rowRight = 340;
    // jsdom has no layout: a 390 pixel wide phone, and a row ending at rowRight.
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(390);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ right: rowRight, left: 0, top: 0, bottom: 0, width: rowRight, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
    );
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
  });

  const row = () => container.querySelector<HTMLElement>('[data-testid="row"]');

  it("writes how far the row ends from the right edge of the window, and measures again when the window changes", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<Row shown />);
    });
    expect(row()!.style.getPropertyValue(RIGHT_INSET_PROPERTY)).toBe("50px");

    rowRight = 300;
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(row()!.style.getPropertyValue(RIGHT_INSET_PROPERTY)).toBe("90px");

    act(() => {
      root.unmount();
    });
  });

  it("measures a row that only appears later, as the reply box does once it may be used", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<Row shown={false} />);
    });
    act(() => {
      root.render(<Row shown />);
    });
    expect(row()!.style.getPropertyValue(RIGHT_INSET_PROPERTY)).toBe("50px");
    act(() => {
      root.unmount();
    });
  });

  it("stops listening once the row has gone", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<Row shown />);
    });
    const removed = vi.spyOn(window, "removeEventListener");
    act(() => {
      root.render(<Row shown={false} />);
    });
    expect(removed).toHaveBeenCalledWith("resize", expect.any(Function));
    act(() => {
      root.unmount();
    });
  });
});
