import { beforeEach, describe, expect, it } from "vitest";
import {
  COMPOSER_HEIGHT_STORAGE_KEY,
  DEFAULT_COMPOSER_HEIGHT,
  DEFAULT_LIST_WIDTH,
  LIST_WIDTH_STORAGE_KEY,
  MAX_COMPOSER_HEIGHT,
  MAX_LIST_WIDTH,
  MIN_COMPOSER_HEIGHT,
  MIN_LIST_WIDTH,
  clampComposerHeight,
  clampListWidth,
  loadPaneSize,
  savePaneSize,
} from "./helpscout-pane-layout";

describe("clampListWidth", () => {
  it("keeps a width inside the allowed range", () => {
    expect(clampListWidth(420)).toBe(420);
  });

  it("clamps to the bounds", () => {
    expect(clampListWidth(10)).toBe(MIN_LIST_WIDTH);
    expect(clampListWidth(5000)).toBe(MAX_LIST_WIDTH);
  });

  it("rounds sub-pixel drag positions", () => {
    expect(clampListWidth(361.6)).toBe(362);
  });

  it("falls back to the default for non-numbers", () => {
    expect(clampListWidth(Number.NaN)).toBe(DEFAULT_LIST_WIDTH);
    expect(clampListWidth(Number.POSITIVE_INFINITY)).toBe(DEFAULT_LIST_WIDTH);
  });
});

describe("clampComposerHeight", () => {
  it("clamps to the bounds", () => {
    expect(clampComposerHeight(20)).toBe(MIN_COMPOSER_HEIGHT);
    expect(clampComposerHeight(9000)).toBe(MAX_COMPOSER_HEIGHT);
  });

  it("keeps a height inside the allowed range", () => {
    expect(clampComposerHeight(300)).toBe(300);
  });

  it("falls back to the default for non-numbers", () => {
    expect(clampComposerHeight(Number.NaN)).toBe(DEFAULT_COMPOSER_HEIGHT);
  });
});

describe("loadPaneSize / savePaneSize", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns the fallback when nothing is stored", () => {
    expect(loadPaneSize(LIST_WIDTH_STORAGE_KEY, DEFAULT_LIST_WIDTH, clampListWidth)).toBe(
      DEFAULT_LIST_WIDTH,
    );
  });

  it("round-trips a saved size", () => {
    savePaneSize(LIST_WIDTH_STORAGE_KEY, 448.4);
    expect(loadPaneSize(LIST_WIDTH_STORAGE_KEY, DEFAULT_LIST_WIDTH, clampListWidth)).toBe(448);
  });

  it("clamps a stored value that is out of range", () => {
    savePaneSize(COMPOSER_HEIGHT_STORAGE_KEY, 4000);
    expect(
      loadPaneSize(COMPOSER_HEIGHT_STORAGE_KEY, DEFAULT_COMPOSER_HEIGHT, clampComposerHeight),
    ).toBe(MAX_COMPOSER_HEIGHT);
  });

  it("falls back when the stored value is not a number", () => {
    localStorage.setItem(LIST_WIDTH_STORAGE_KEY, "wide");
    expect(loadPaneSize(LIST_WIDTH_STORAGE_KEY, DEFAULT_LIST_WIDTH, clampListWidth)).toBe(
      DEFAULT_LIST_WIDTH,
    );
  });
});
