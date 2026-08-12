import { describe, expect, it } from "vitest";
import {
  Z_BASE_OVERLAY,
  Z_PANEL,
  Z_SKIP_LINK,
  Z_TOAST,
  Z_TOOLTIP,
  zLayerValue,
} from "./z-layers";

describe("stacking order", () => {
  it("reads a numeric value out of every layer constant", () => {
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

  it("orders the whole scale strictly, so no two layers can tie", () => {
    const scale = [Z_BASE_OVERLAY, Z_PANEL, Z_TOOLTIP, Z_TOAST, Z_SKIP_LINK].map(zLayerValue);
    for (let i = 1; i < scale.length; i++) {
      expect(scale[i]).toBeGreaterThan(scale[i - 1]!);
    }
  });
});
