import { describe, expect, it } from "vitest";
import {
  ABOVE_MOBILE_BOTTOM_NAV_CLASS,
  MOBILE_BOTTOM_NAV_HEIGHT_CLASS,
  OWN_LINE_ACTIONS_CLASS,
  WRAPPING_ROW_CLASS,
  spacingClassPixels,
} from "./narrow-layout";

describe("spacingClassPixels", () => {
  it("reads a plain Tailwind scale value", () => {
    expect(spacingClassPixels("h-16")).toBe(64);
    expect(spacingClassPixels("bottom-4")).toBe(16);
  });

  it("reads a rem length inside an arbitrary value", () => {
    expect(spacingClassPixels("bottom-[calc(5rem+env(safe-area-inset-bottom))]")).toBe(80);
  });

  it("gives NaN for anything it cannot read", () => {
    expect(spacingClassPixels("flex-wrap")).toBeNaN();
  });
});

describe("the floating-control offset above the phone bottom bar", () => {
  // The round Clippy launcher sat at bottom-4 on a higher layer than the bar,
  // so it covered the last button in the bar exactly and that button could not
  // be tapped at all. The two numbers lived in two files with no reason to know
  // about each other, so this checks they still agree.
  it("clears the bar's own height", () => {
    const barHeight = spacingClassPixels(MOBILE_BOTTOM_NAV_HEIGHT_CLASS);
    const phoneOffset = ABOVE_MOBILE_BOTTOM_NAV_CLASS.split(" ").find(
      (part) => !part.includes(":"),
    );
    expect(phoneOffset).toBeDefined();
    expect(spacingClassPixels(phoneOffset!)).toBeGreaterThan(barHeight);
  });

  it("drops back to the ordinary corner offset where the bar is hidden", () => {
    // MobileBottomNav is md:hidden, so the offset has to stop at the same
    // breakpoint or every desktop window keeps a gap it does not need.
    expect(ABOVE_MOBILE_BOTTOM_NAV_CLASS).toContain("md:bottom-4");
  });
});

describe("an action row that takes its own line when it is too wide", () => {
  it("is allowed to wrap onto a second line", () => {
    expect(WRAPPING_ROW_CLASS.split(" ")).toContain("flex-wrap");
    expect(OWN_LINE_ACTIONS_CLASS.split(" ")).toContain("flex-wrap");
  });

  it("takes a whole line of its own below a laptop width", () => {
    // basis-full rather than w-full: it is the flex base size that decides
    // which line an item lands on.
    expect(OWN_LINE_ACTIONS_CLASS.split(" ")).toContain("basis-full");
  });

  // The bug this replaced was a bare `shrink-0` with no wrapping, which is what
  // held the five buttons on one 481 pixel line inside a 333 pixel card and cut
  // the last two off with no way to reach them. Anything that pins the row to a
  // single line has to be behind a breakpoint from now on.
  it("only pins itself to one line at a width where it fits", () => {
    const unconditional = OWN_LINE_ACTIONS_CLASS.split(" ").filter((part) => !part.includes(":"));
    expect(unconditional).not.toContain("shrink-0");
    expect(unconditional).not.toContain("flex-nowrap");
    expect(OWN_LINE_ACTIONS_CLASS).toContain("lg:shrink-0");
    expect(OWN_LINE_ACTIONS_CLASS).toContain("lg:flex-nowrap");
  });
});
