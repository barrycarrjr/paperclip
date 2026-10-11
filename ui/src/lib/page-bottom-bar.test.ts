// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PAGE_BOTTOM_BAR_END_ROOM_PROPERTY,
  PAGE_BOTTOM_BAR_REACH_PX,
  PAGE_BOTTOM_BAR_ROOM_PROPERTY,
  pageBottomBarRoom,
  registerPageBottomBar,
  setPhoneBottomBar,
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

  // On a phone a page's bar rests on top of the bottom bar, 64 pixels tall
  // with its 1 pixel border.
  const SHOWN = { phoneBottomBar: { height: 65, shown: true } };
  const AWAY = { phoneBottomBar: { height: 65, shown: false } };

  it("counts a page's bar resting on the phone bottom bar, which is further up than the reach", () => {
    // Held against the window alone, the agent Save bar resting there did not
    // count, and the launcher sat on its Save button.
    expect(pageBottomBarRoom([barAt(65, 48)], WINDOW_HEIGHT, SHOWN)).toBe(65 + 48);
  });

  it("counts a bar floating a little above the phone bottom bar, as the selection bars do", () => {
    expect(pageBottomBarRoom([barAt(65 + 24, 46)], WINDOW_HEIGHT, SHOWN)).toBe(65 + 24 + 46);
  });

  it("still leaves out a bar higher up than the reach above the phone bottom bar", () => {
    // A sticky bar scrolled to its own place well above the bottom.
    expect(pageBottomBarRoom([barAt(65 + PAGE_BOTTOM_BAR_REACH_PX + 1, 120)], WINDOW_HEIGHT, SHOWN)).toBe(65);
  });

  it("takes the phone bottom bar's own share from whether it shows, wherever its slide has got to", () => {
    expect(pageBottomBarRoom([], WINDOW_HEIGHT, SHOWN)).toBe(65);
    expect(pageBottomBarRoom([], WINDOW_HEIGHT, AWAY)).toBe(0);
  });

  it("keeps counting a bar resting on the phone bottom bar while the two slide away together", () => {
    // Half way down. Held against the very bottom, a bar still 65 pixels up
    // dropped out for the first frame of the slide, and the launcher jumped.
    expect(pageBottomBarRoom([barAt(65, 48)], WINDOW_HEIGHT, AWAY)).toBe(65 + 48);
    expect(pageBottomBarRoom([barAt(30, 48)], WINDOW_HEIGHT, AWAY)).toBe(30 + 48);
    expect(pageBottomBarRoom([barAt(0, 48)], WINDOW_HEIGHT, AWAY)).toBe(48);
  });

  it("counts a bar floating above a tall safe area, as Android reports behind a three-button bar", () => {
    // 48 pixels of safe area and a bar 24 pixels above it: 72 up, past the
    // reach from the very bottom, so the launcher landed on it.
    expect(pageBottomBarRoom([barAt(48 + 24, 46)], WINDOW_HEIGHT, { safeArea: 48 })).toBe(48 + 24 + 46);
    expect(pageBottomBarRoom([barAt(48 + 24, 46)], WINDOW_HEIGHT)).toBe(0);
  });
});

describe("registering a page's bottom bar", () => {
  const roomOnPage = () => document.documentElement.style.getPropertyValue(PAGE_BOTTOM_BAR_ROOM_PROPERTY);
  const endRoomOnPage = () => document.documentElement.style.getPropertyValue(PAGE_BOTTOM_BAR_END_ROOM_PROPERTY);

  /** Puts a bar's box where it is now, given how far up it sits and how tall it is. */
  function place(bar: HTMLElement, bottomOffset: number, height: number) {
    const box = barAt(bottomOffset, height);
    bar.getBoundingClientRect = () =>
      ({ ...box, left: 0, right: 100, width: 100, height, x: 0, y: box.top, toJSON: () => box }) as DOMRect;
  }

  function makeBar(bottomOffset: number, height: number, position: "fixed" | "sticky" = "sticky") {
    const bar = document.createElement("div");
    bar.style.position = position;
    document.body.appendChild(bar);
    place(bar, bottomOffset, height);
    return bar;
  }

  /** The phone bottom bar, 64 pixels tall with its top border. */
  function makePhoneBottomBar() {
    const nav = document.createElement("nav");
    Object.defineProperty(nav, "offsetHeight", { configurable: true, value: 65 });
    document.body.appendChild(nav);
    return nav;
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
    document.documentElement.style.removeProperty(PAGE_BOTTOM_BAR_END_ROOM_PROPERTY);
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

  it("measures again when a bar has finished sliding, which no scroll or resize reports", () => {
    // The phone bottom bar slides away as the page scrolls, and a page's bar
    // resting on it slides down with it, after the scroll that started it.
    const nav = makePhoneBottomBar();
    const releaseShown = setPhoneBottomBar(nav, true);
    const saveBar = makeBar(65, 48);
    const releaseSave = registerPageBottomBar(saveBar);
    expect(roomOnPage()).toBe("113px");

    releaseShown();
    const releaseAway = setPhoneBottomBar(nav, false);
    place(saveBar, 0, 48);
    saveBar.dispatchEvent(new Event("transitionend"));
    expect(roomOnPage()).toBe("48px");

    releaseSave();
    releaseAway();
    expect(roomOnPage()).toBe("");
  });

  it("takes the phone bottom bar's share from whether it shows, never measuring it as it slides", () => {
    const nav = makePhoneBottomBar();
    const measured = vi.spyOn(nav, "getBoundingClientRect");
    const releaseShown = setPhoneBottomBar(nav, true);
    expect(roomOnPage()).toBe("65px");
    releaseShown();
    const releaseAway = setPhoneBottomBar(nav, false);
    expect(roomOnPage()).toBe("");
    expect(measured).not.toHaveBeenCalled();
    releaseAway();
  });

  it("keeps room at the end of the page for a bar fixed over it, and none for one that sticks", () => {
    // Two rows of selection buttons, 118 pixels, 24 pixels above the bottom
    // bar, hid the last rows of the portfolio issues list.
    const nav = makePhoneBottomBar();
    const releaseNav = setPhoneBottomBar(nav, true);
    const releaseSelection = registerPageBottomBar(makeBar(65 + 24, 118, "fixed"));
    expect(endRoomOnPage()).toBe(`${65 + 24 + 118}px`);
    releaseSelection();
    expect(endRoomOnPage()).toBe("");

    // A sticky bar takes its own place at the end of the page.
    const releaseSticky = registerPageBottomBar(makeBar(65, 48, "sticky"));
    expect(roomOnPage()).toBe(`${65 + 48}px`);
    expect(endRoomOnPage()).toBe("");
    releaseSticky();
    releaseNav();
  });

  it("does not take room back from the end of the page while the same bars are up", () => {
    // They sit lower while the bottom bar is away. Taken back each time that
    // bar slid, the end of the page moved, and so did a page scrolled to it.
    const nav = makePhoneBottomBar();
    const releaseShown = setPhoneBottomBar(nav, true);
    const selection = makeBar(65 + 24, 118, "fixed");
    const releaseSelection = registerPageBottomBar(selection);
    expect(endRoomOnPage()).toBe("207px");

    releaseShown();
    const releaseAway = setPhoneBottomBar(nav, false);
    place(selection, 24, 118);
    selection.dispatchEvent(new Event("transitionend"));
    expect(roomOnPage()).toBe(`${24 + 118}px`);
    expect(endRoomOnPage()).toBe("207px");

    releaseSelection();
    expect(endRoomOnPage()).toBe("");
    releaseAway();
  });

  it("stops listening for the end of a slide once a bar is released", () => {
    const released = makeBar(24, 46);
    const release = registerPageBottomBar(released);
    const kept = makeBar(0, 30);
    const keep = registerPageBottomBar(kept);
    release();
    expect(roomOnPage()).toBe("30px");
    // Every measurement reads the bar still there, so count those.
    const measureKept = vi.spyOn(kept, "getBoundingClientRect");
    released.dispatchEvent(new Event("transitionend"));
    expect(measureKept).not.toHaveBeenCalled();
    kept.dispatchEvent(new Event("transitionend"));
    expect(measureKept).toHaveBeenCalledTimes(1);
    keep();
  });
});
