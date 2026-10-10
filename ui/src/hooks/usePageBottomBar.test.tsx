// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAGE_BOTTOM_BAR_ROOM_PROPERTY } from "../lib/page-bottom-bar";
import { usePageBottomBarRef } from "./usePageBottomBar";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The agent Save bar, the selection action bars and the sticky save bars are
 * pinned along the bottom of the window, where the Clippy launcher, the scroll
 * buttons and the toasts float too. While one is on the page, the room it takes
 * is on the document for those to sit above it, and it goes when the bar goes.
 */
describe("usePageBottomBarRef", () => {
  let container: HTMLDivElement;
  let root: Root;
  let setShowBar: (show: boolean) => void = () => {};
  let forwarded: { current: HTMLDivElement | null } | null = null;

  const roomOnPage = () => document.documentElement.style.getPropertyValue(PAGE_BOTTOM_BAR_ROOM_PROPERTY);

  /** jsdom has no layout: give every div the box of a bar 24 pixels up and 46 tall. */
  function placeBars() {
    vi.spyOn(HTMLDivElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ top: 830, bottom: 876, left: 0, right: 200, width: 200, height: 46, x: 0, y: 830 }) as DOMRect,
    );
  }

  function Page({ forward }: { forward: boolean }) {
    const [showBar, setShowBarState] = useState(true);
    setShowBar = setShowBarState;
    const ownRef = useRef<HTMLDivElement | null>(null);
    forwarded = ownRef;
    const barRef = usePageBottomBarRef(forward ? ownRef : undefined);
    return showBar ? <div ref={barRef}>Save</div> : null;
  }

  beforeEach(() => {
    vi.stubGlobal("innerHeight", 900);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      // 0, as a frame that has already run: the code keeps the number it is
      // given, and only asks for a frame while it holds none.
      return 0;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    placeBars();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    document.documentElement.style.removeProperty(PAGE_BOTTOM_BAR_ROOM_PROPERTY);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    forwarded = null;
  });

  it("puts the bar's room on the document while it shows, and takes it away when it goes", async () => {
    await act(async () => {
      root.render(<Page forward={false} />);
    });
    expect(roomOnPage()).toBe("70px");

    await act(async () => {
      setShowBar(false);
    });
    expect(roomOnPage()).toBe("");

    await act(async () => {
      setShowBar(true);
    });
    expect(roomOnPage()).toBe("70px");
  });

  it("gives the room back when the page goes", async () => {
    await act(async () => {
      root.render(<Page forward={false} />);
    });
    expect(roomOnPage()).toBe("70px");
    await act(async () => {
      root.render(null);
    });
    expect(roomOnPage()).toBe("");
  });

  it("keeps a ref the bar already had pointing at it, and clears it when the bar goes", async () => {
    await act(async () => {
      root.render(<Page forward />);
    });
    expect(forwarded?.current?.textContent).toBe("Save");

    await act(async () => {
      setShowBar(false);
    });
    expect(forwarded?.current).toBeNull();
  });
});
