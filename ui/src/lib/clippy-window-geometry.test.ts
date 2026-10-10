import { describe, expect, it } from "vitest";
import {
  FLOATING_EDGE_MARGIN,
  FLOATING_MIN_HEIGHT,
  FLOATING_MIN_WIDTH,
  MIN_PAGE_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampFloatingRect,
  clampSidebarWidth,
  growFloatingRect,
  isClippyMode,
  moveFloatingRect,
  resizeFloatingRect,
} from "./clippy-window-geometry";

const desktop = { width: 1440, height: 900 };

describe("clampFloatingRect", () => {
  it("leaves a window that fits alone", () => {
    const rect = { width: 420, height: 620, right: 16, bottom: 16 };
    expect(clampFloatingRect(rect, desktop)).toEqual(rect);
  });

  it("shrinks a window bigger than the browser window to fit inside it", () => {
    const clamped = clampFloatingRect({ width: 2000, height: 2000, right: 16, bottom: 16 }, desktop);
    expect(clamped.width).toBe(desktop.width - 2 * FLOATING_EDGE_MARGIN);
    expect(clamped.height).toBe(desktop.height - 2 * FLOATING_EDGE_MARGIN);
    expect(clamped.right).toBe(FLOATING_EDGE_MARGIN);
    expect(clamped.bottom).toBe(FLOATING_EDGE_MARGIN);
  });

  it("brings back a window that was moved off screen in a bigger browser window", () => {
    const clamped = clampFloatingRect({ width: 420, height: 620, right: 1300, bottom: 600 }, desktop);
    expect(clamped.right).toBe(desktop.width - FLOATING_EDGE_MARGIN - 420);
    expect(clamped.bottom).toBe(desktop.height - FLOATING_EDGE_MARGIN - 620);
  });

  it("never goes below the smallest usable size", () => {
    const clamped = clampFloatingRect({ width: 10, height: 10, right: 16, bottom: 16 }, desktop);
    expect(clamped.width).toBe(FLOATING_MIN_WIDTH);
    expect(clamped.height).toBe(FLOATING_MIN_HEIGHT);
  });
});

describe("resizeFloatingRect", () => {
  const rect = { width: 420, height: 620, right: 16, bottom: 16 };

  it("grows leftwards from the left edge and keeps the right edge where it was", () => {
    const next = resizeFloatingRect(rect, "left", { x: 900, y: 0 }, desktop);
    expect(next.width).toBe(desktop.width - 16 - 900);
    expect(next.right).toBe(16);
    expect(next.height).toBe(620);
  });

  it("grows upwards from the top edge and keeps the bottom edge where it was", () => {
    const next = resizeFloatingRect(rect, "top", { x: 0, y: 100 }, desktop);
    expect(next.height).toBe(desktop.height - 16 - 100);
    expect(next.bottom).toBe(16);
    expect(next.width).toBe(420);
  });

  it("does both from the top left corner, stopping at the edges", () => {
    const next = resizeFloatingRect(rect, "top-left", { x: -50, y: -50 }, desktop);
    expect(next.width).toBe(desktop.width - 16 - FLOATING_EDGE_MARGIN);
    expect(next.height).toBe(desktop.height - 16 - FLOATING_EDGE_MARGIN);
  });
});

describe("moveFloatingRect", () => {
  it("moves with the pointer and stops at the edges", () => {
    const rect = { width: 420, height: 620, right: 16, bottom: 16 };
    expect(moveFloatingRect(rect, { dx: -200, dy: -100 }, desktop)).toMatchObject({ right: 216, bottom: 116 });
    expect(moveFloatingRect(rect, { dx: 500, dy: 500 }, desktop)).toMatchObject({
      right: FLOATING_EDGE_MARGIN,
      bottom: FLOATING_EDGE_MARGIN,
    });
  });
});

describe("clampSidebarWidth", () => {
  it("keeps the docked panel between its minimum and what leaves the page a usable width", () => {
    expect(clampSidebarWidth(100, 1440)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(500, 1440)).toBe(500);
    expect(clampSidebarWidth(1400, 1440)).toBe(1440 - MIN_PAGE_WIDTH);
  });

  it("counts the navigation and the properties panel, not just the window", () => {
    // 72 rail + 240 navigation + 320 properties panel. Three fifths of 1440
    // used to be allowed here, which left the page 0 pixels.
    const reserved = 72 + 240 + 320;
    expect(clampSidebarWidth(864, 1440, reserved)).toBe(1440 - reserved - MIN_PAGE_WIDTH);
    expect(1440 - reserved - clampSidebarWidth(864, 1440, reserved)).toBe(MIN_PAGE_WIDTH);
  });

  it("keeps its own minimum on a window too small for both", () => {
    expect(clampSidebarWidth(600, 1280, 72 + 240 + 320)).toBe(SIDEBAR_MIN_WIDTH);
  });
});

describe("growFloatingRect", () => {
  it("grows towards the top left and keeps the bottom right corner put", () => {
    const rect = { width: 420, height: 620, right: 16, bottom: 16 };
    expect(growFloatingRect(rect, { width: 24, height: 0 }, desktop)).toEqual({ ...rect, width: 444 });
    expect(growFloatingRect(rect, { width: 0, height: 24 }, desktop)).toEqual({ ...rect, height: 644 });
    expect(growFloatingRect(rect, { width: -24, height: -24 }, desktop)).toEqual({ ...rect, width: 396, height: 596 });
  });
});

describe("isClippyMode", () => {
  it("accepts the three layouts and nothing else", () => {
    expect(isClippyMode("floating")).toBe(true);
    expect(isClippyMode("sidebar")).toBe(true);
    expect(isClippyMode("fullscreen")).toBe(true);
    expect(isClippyMode("drawer")).toBe(false);
    expect(isClippyMode(null)).toBe(false);
  });
});
