// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAGE_END_ROOM_EXTRA_PX } from "../lib/narrow-layout";
import { usePageEndRoom } from "./usePageEndRoom";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Scrolled to its end, the Pipelines "add items" page put its Submit button
 * on the Clippy launcher's top edge. Layout now keeps room at the end of a page
 * that scrolls, marked by `data-page-end-room` on the page area. jsdom has no
 * layout, so these give the page area its heights by hand and stand in for
 * the ResizeObserver that reports them changing.
 */
describe("usePageEndRoom", () => {
  let container: HTMLDivElement;
  let root: Root;
  let pageArea: HTMLElement | null = null;
  let observed: Array<() => void> = [];
  /** What each live observer is watching. */
  let watched = new Map<FakeResizeObserver, Set<Element>>();
  const heights = { scrollHeight: 800, clientHeight: 800 };

  class FakeResizeObserver {
    constructor(private readonly callback: () => void) {
      observed.push(callback);
      watched.set(this, new Set());
    }
    observe(target: Element) {
      watched.get(this)?.add(target);
    }
    unobserve(target: Element) {
      watched.get(this)?.delete(target);
    }
    disconnect() {
      observed = observed.filter((callback) => callback !== this.callback);
      watched.delete(this);
    }
  }

  /** Whether any observer still watches the element. */
  const isWatched = (element: Element) => [...watched.values()].some((targets) => targets.has(element));

  /** The page grows or shrinks: the observers report it. */
  async function pageIs(scrollHeight: number) {
    heights.scrollHeight = scrollHeight;
    await act(async () => {
      for (const callback of observed) callback();
    });
  }

  /** The page area, showing the page at one address (`page`, so a new address is a new page). */
  function PageArea({ enabled, page = "first" }: { enabled: boolean; page?: string }) {
    const ref = useRef<HTMLElement | null>(null);
    usePageEndRoom(ref, enabled);
    return (
      <main
        ref={(element) => {
          ref.current = element;
          pageArea = element;
          if (element) {
            Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => heights.scrollHeight });
            Object.defineProperty(element, "clientHeight", { configurable: true, get: () => heights.clientHeight });
          }
        }}
      >
        <div key={page}>Page {page}</div>
      </main>
    );
  }

  const roomIsOn = () => pageArea?.dataset.pageEndRoom === "true";

  beforeEach(() => {
    observed = [];
    watched = new Map();
    heights.scrollHeight = 800;
    heights.clientHeight = 800;
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      // 0, as a frame that has already run: the code keeps the number it is
      // given, and only asks for a frame while it holds none.
      return 0;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
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
    pageArea = null;
  });

  it("adds the room while the page is longer than the page area", async () => {
    heights.scrollHeight = 1400;
    await act(async () => {
      root.render(<PageArea enabled />);
    });
    expect(roomIsOn()).toBe(true);
  });

  it("leaves a page that fits the area exactly at its full height", async () => {
    await act(async () => {
      root.render(<PageArea enabled />);
    });
    expect(roomIsOn()).toBe(false);
  });

  it("follows the page as it grows and shrinks, without being switched by its own room", async () => {
    await act(async () => {
      root.render(<PageArea enabled />);
    });
    await pageIs(1400);
    expect(roomIsOn()).toBe(true);

    // With the room on, the page area reports the room in its height too:
    // a page that only overflows because of it must not keep it.
    await pageIs(800 + PAGE_END_ROOM_EXTRA_PX - 10);
    expect(roomIsOn()).toBe(false);
  });

  it("does nothing on a phone, which keeps room for its bottom bar already", async () => {
    heights.scrollHeight = 1400;
    await act(async () => {
      root.render(<PageArea enabled={false} />);
    });
    expect(roomIsOn()).toBe(false);
  });

  it("stops watching a page once the address moves on, and watches the page that came instead", async () => {
    await act(async () => {
      root.render(<PageArea enabled page="first" />);
    });
    const first = pageArea!.firstElementChild!;
    expect(isWatched(first)).toBe(true);

    await act(async () => {
      root.render(<PageArea enabled page="second" />);
    });
    // The page area's own change is told after React is done with it.
    await act(async () => {});
    const second = pageArea!.firstElementChild!;
    expect(second).not.toBe(first);
    expect(isWatched(second)).toBe(true);
    // Every page shown used to stay watched, and held on to, for good.
    expect(isWatched(first)).toBe(false);
    expect(isWatched(pageArea!)).toBe(true);
  });

  it("takes the room away when the page area goes", async () => {
    heights.scrollHeight = 1400;
    await act(async () => {
      root.render(<PageArea enabled />);
    });
    const area = pageArea!;
    expect(area.dataset.pageEndRoom).toBe("true");
    await act(async () => {
      root.render(<PageArea enabled={false} />);
    });
    expect(area.dataset.pageEndRoom).toBeUndefined();
  });
});
