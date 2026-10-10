// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useElementWidth } from "./useElementWidth";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The JavaScript side of a container query: Skill Studio uses it to choose
 * between its three panes and tabs by the room it actually has, which docked
 * Clippy takes without the window getting any narrower.
 */
describe("useElementWidth", () => {
  let container: HTMLDivElement;
  let root: Root;
  let width: number | null = null;
  let report: ((width: number) => void) | null = null;

  class FakeResizeObserver {
    constructor(callback: (entries: Array<{ contentRect: { width: number } }>) => void) {
      report = (next) => callback([{ contentRect: { width: next } }]);
    }
    observe() {}
    unobserve() {}
    disconnect() {
      report = null;
    }
  }

  function Measured() {
    const [ref, measured] = useElementWidth<HTMLDivElement>();
    width = measured;
    return <div ref={ref}>Studio</div>;
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    width = null;
    report = null;
  });

  it("follows the element's width as it changes", async () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    await act(async () => {
      root.render(<Measured />);
    });
    // jsdom lays nothing out, so the first reading is no width at all.
    expect(width).toBeNull();

    await act(async () => {
      report?.(612.4);
    });
    expect(width).toBe(612);

    await act(async () => {
      report?.(1080);
    });
    expect(width).toBe(1080);
  });

  it("stops watching when the element goes", async () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    await act(async () => {
      root.render(<Measured />);
    });
    expect(report).not.toBeNull();
    await act(async () => {
      root.render(null);
    });
    expect(report).toBeNull();
  });

  it("stays unknown where ResizeObserver does not exist, so callers keep their old behaviour", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    await act(async () => {
      root.render(<Measured />);
    });
    expect(width).toBeNull();
  });
});
