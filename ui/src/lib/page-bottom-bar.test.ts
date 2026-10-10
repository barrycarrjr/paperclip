// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PAGE_BOTTOM_BAR_REACH_PX,
  PAGE_BOTTOM_BAR_ROOM_PROPERTY,
  pageBottomBarRoom,
  registerPageBottomBar,
} from "./page-bottom-bar";

const WINDOW_HEIGHT = 900;

/** A bar's box, given how far up from the bottom of the window it sits and how tall it is. */
function barAt(bottomOffset: number, height: number) {
  return { top: WINDOW_HEIGHT - bottomOffset - height, bottom: WINDOW_HEIGHT - bottomOffset };
}

describe("how much room a page's bottom bar takes", () => {
  it("is how far up from the bottom of the window the bar reaches", () => {
    // The agent Save bar: 24 pixels up, 46 pixels tall.
    expect(pageBottomBarRoom([barAt(24, 46)], WINDOW_HEIGHT)).toBe(70);
  });

  it("is nothing when no bar is there", () => {
    expect(pageBottomBarRoom([], WINDOW_HEIGHT)).toBe(0);
  });

  it("leaves out a bar that is not drawn", () => {
    expect(pageBottomBarRoom([{ top: 0, bottom: 0 }], WINDOW_HEIGHT)).toBe(0);
  });

  it("leaves out a bar higher up the window, which is not in the launcher's way", () => {
    // A sticky bar that has scrolled to its own place, above the page end.
    expect(pageBottomBarRoom([barAt(PAGE_BOTTOM_BAR_REACH_PX + 1, 50)], WINDOW_HEIGHT)).toBe(0);
    expect(pageBottomBarRoom([barAt(PAGE_BOTTOM_BAR_REACH_PX, 50)], WINDOW_HEIGHT)).toBe(
      PAGE_BOTTOM_BAR_REACH_PX + 50,
    );
  });

  it("counts a bar pinned to the very bottom, and one partly below it", () => {
    expect(pageBottomBarRoom([barAt(0, 57)], WINDOW_HEIGHT)).toBe(57);
    expect(pageBottomBarRoom([barAt(-20, 57)], WINDOW_HEIGHT)).toBe(37);
  });

  it("takes the highest bar when there are two", () => {
    expect(pageBottomBarRoom([barAt(0, 57), barAt(24, 46)], WINDOW_HEIGHT)).toBe(70);
  });

  it("never pushes the launcher past the middle of the window", () => {
    expect(pageBottomBarRoom([barAt(0, 700)], WINDOW_HEIGHT)).toBe(WINDOW_HEIGHT / 2);
  });

  it("only counts bars as far up as the launcher's corner", () => {
    // The launcher sits 1rem up and is 2.5rem tall: 56 pixels. A bar whose
    // lower edge is above that cannot be under it.
    expect(PAGE_BOTTOM_BAR_REACH_PX).toBeGreaterThanOrEqual(56);
    expect(PAGE_BOTTOM_BAR_REACH_PX).toBeLessThan(72);
  });
});

describe("registering a page's bottom bar", () => {
  const roomOnPage = () => document.documentElement.style.getPropertyValue(PAGE_BOTTOM_BAR_ROOM_PROPERTY);

  function makeBar(bottomOffset: number, height: number) {
    const bar = document.createElement("div");
    document.body.appendChild(bar);
    const box = barAt(bottomOffset, height);
    bar.getBoundingClientRect = () =>
      ({ ...box, left: 0, right: 100, width: 100, height, x: 0, y: box.top, toJSON: () => box }) as DOMRect;
    return bar;
  }

  beforeEach(() => {
    vi.stubGlobal("innerHeight", WINDOW_HEIGHT);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      // 0, as a frame that has already run: the code keeps the number it is
      // given, and only asks for a frame while it holds none.
      return 0;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  afterEach(() => {
    document.body.innerHTML = "";
    document.documentElement.style.removeProperty(PAGE_BOTTOM_BAR_ROOM_PROPERTY);
    vi.unstubAllGlobals();
  });

  it("puts the room on the page while the bar is there and takes it away after", () => {
    const release = registerPageBottomBar(makeBar(24, 46));
    expect(roomOnPage()).toBe("70px");
    release();
    expect(roomOnPage()).toBe("");
  });

  it("keeps the room for the bar still there when another goes", () => {
    const releaseSave = registerPageBottomBar(makeBar(24, 46));
    const releaseSticky = registerPageBottomBar(makeBar(0, 100));
    expect(roomOnPage()).toBe("100px");
    releaseSticky();
    expect(roomOnPage()).toBe("70px");
    releaseSave();
    expect(roomOnPage()).toBe("");
  });

  it("follows a bar as the page scrolls it along the bottom", () => {
    const bar = makeBar(0, 60);
    const release = registerPageBottomBar(bar);
    expect(roomOnPage()).toBe("60px");
    // Scrolled to its own place, higher up than the launcher's corner.
    const box = barAt(120, 60);
    bar.getBoundingClientRect = () =>
      ({ ...box, left: 0, right: 100, width: 100, height: 60, x: 0, y: box.top, toJSON: () => box }) as DOMRect;
    document.dispatchEvent(new Event("scroll"));
    expect(roomOnPage()).toBe("");
    release();
  });

  it("is harmless to release twice", () => {
    const release = registerPageBottomBar(makeBar(24, 46));
    release();
    release();
    expect(roomOnPage()).toBe("");
  });
});
