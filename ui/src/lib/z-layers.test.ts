import { describe, expect, it } from "vitest";
import {
  Z_BASE_OVERLAY,
  Z_CLIPPY,
  Z_PAGE_FLOATING,
  Z_PAGE_NOTICE,
  Z_PANEL,
  Z_SKIP_LINK,
  Z_TOAST,
  Z_TOOLTIP,
  zLayerValue,
} from "./z-layers";

describe("stacking order", () => {
  it("reads a numeric value out of every layer constant", () => {
    expect(zLayerValue(Z_PAGE_FLOATING)).toBe(40);
    expect(zLayerValue(Z_PAGE_NOTICE)).toBe(42);
    expect(zLayerValue(Z_CLIPPY)).toBe(45);
    expect(zLayerValue(Z_BASE_OVERLAY)).toBe(50);
    expect(zLayerValue(Z_PANEL)).toBe(60);
    expect(zLayerValue(Z_TOOLTIP)).toBe(70);
    expect(zLayerValue(Z_TOAST)).toBe(120);
    expect(zLayerValue(Z_SKIP_LINK)).toBe(200);
  });

  it("returns NaN for something that is not a layer class", () => {
    expect(zLayerValue("flex")).toBeNaN();
    expect(zLayerValue("z-auto")).toBeNaN();
    expect(zLayerValue("")).toBeNaN();
  });

  it("puts tooltips above panels", () => {
    // The regression this guards: tooltips and dialogs shared layer 50 while
    // popovers sat at 60. The sidebar account menu is a popover that CONTAINS
    // tooltips, so the labels on its icon row rendered behind the menu itself
    // and could not be read at all.
    expect(zLayerValue(Z_TOOLTIP)).toBeGreaterThan(zLayerValue(Z_PANEL));
  });

  it("keeps the Clippy window above everything a page draws and below dialogs", () => {
    // Pages had their own selection bars and notices on z-50, the dialog
    // layer, so they drew over Clippy in every layout, full screen included.
    // A dialog opened while Clippy is on screen must still come up in front.
    expect(zLayerValue(Z_CLIPPY)).toBeGreaterThan(zLayerValue(Z_PAGE_FLOATING));
    expect(zLayerValue(Z_CLIPPY)).toBeGreaterThan(zLayerValue(Z_PAGE_NOTICE));
    expect(zLayerValue(Z_CLIPPY)).toBeLessThan(zLayerValue(Z_BASE_OVERLAY));
  });

  it("orders the whole scale strictly, so no two layers can tie", () => {
    const scale = [
      Z_PAGE_FLOATING,
      Z_PAGE_NOTICE,
      Z_CLIPPY,
      Z_BASE_OVERLAY,
      Z_PANEL,
      Z_TOOLTIP,
      Z_TOAST,
      Z_SKIP_LINK,
    ].map(zLayerValue);
    for (let i = 1; i < scale.length; i++) {
      expect(scale[i]).toBeGreaterThan(scale[i - 1]!);
    }
  });
});
