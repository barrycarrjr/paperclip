import { describe, expect, it } from "vitest";
import {
  ABOVE_MOBILE_BOTTOM_NAV_CLASS,
  FILLS_OR_KEEPS_HEIGHT_CLASS,
  MOBILE_BOTTOM_NAV_HEIGHT_CLASS,
  OWN_LINE_ACTIONS_CLASS,
  PAGE_AREA_CLIPS_SIDEWAYS_CLASS,
  PHONE_MESSAGE_BODY_HEIGHT_CLASS,
  SCROLL_AREA_FITS_COLUMN_CLASS,
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

describe("keeping the rows in a scrolling column inside the column", () => {
  // Radix wraps the contents of a scrolling column in a box of its own set to
  // `display: table`, and a table box grows to fit its widest content. Every
  // mailbox and folder row on the Email page was therefore as wide as the
  // longest folder name rather than as wide as the column, and ran 64 pixels
  // past the edge that clips it, at 375, 768 and 1280 alike.
  it("turns that box back into an ordinary block", () => {
    expect(SCROLL_AREA_FITS_COLUMN_CLASS).toContain("block");
  });

  it("only reaches the box Radix adds, not everything inside it", () => {
    // `>` and not a descendant selector: the rows themselves must keep their
    // own display, or a row laid out as a flex line would collapse.
    expect(SCROLL_AREA_FITS_COLUMN_CLASS).toContain("[&>div]");
  });

  it("is important, because Radix sets that display on the element itself", () => {
    // A style attribute beats an ordinary rule, so an ordinary rule would do
    // nothing at all here and the fault would look fixed in the source.
    expect(SCROLL_AREA_FITS_COLUMN_CLASS).toContain("!");
  });
});

describe("a panel that has to stay visible when the page is what scrolls", () => {
  it("still fills the height it is given", () => {
    expect(FILLS_OR_KEEPS_HEIGHT_CLASS.split(" ")).toContain("flex-1");
  });

  // On a phone the whole page scrolls, so nothing above a panel has a settled
  // height and `flex-1` on its own resolves to nothing. A spinner or an
  // empty-list message written that way is drawn 0 pixels tall and never
  // appears at all.
  it("keeps a readable height of its own as well", () => {
    const floor = FILLS_OR_KEEPS_HEIGHT_CLASS.split(" ").find((part) =>
      part.startsWith("min-h-"),
    );
    expect(floor).toBeDefined();
    expect(spacingClassPixels(floor!)).toBeGreaterThan(0);
  });
});

describe("how tall a message body is on a phone", () => {
  it("is a real reading height, not a floor", () => {
    expect(PHONE_MESSAGE_BODY_HEIGHT_CLASS.startsWith("h-")).toBe(true);
    expect(PHONE_MESSAGE_BODY_HEIGHT_CLASS.startsWith("min-h-")).toBe(false);
  });

  // dvh, not vh: on a phone the address bar comes and goes, and vh is the
  // height the page would have if it never did.
  it("is measured against the part of the screen the page actually has", () => {
    expect(PHONE_MESSAGE_BODY_HEIGHT_CLASS).toContain("dvh");
  });
});

describe("stopping one page making the whole app slide sideways", () => {
  // A plugin page with panels wider than a phone made the document 392 pixels
  // wide against a 367 pixel page, so the top bar, the menu button and the
  // bottom bar could all be dragged off the side of the screen with it.
  it("cuts off anything wider than the page area", () => {
    expect(PAGE_AREA_CLIPS_SIDEWAYS_CLASS.split(" ")).toContain("overflow-x-clip");
  });

  // CSS turns the other axis into `auto` the moment one axis is `hidden` or
  // `auto`, which would make the page area a scrolling box of its own. On a
  // phone the document is what scrolls, and anything inside set to stick to
  // the top of the screen would stop doing it. Measured in a real browser at
  // 375 wide: pinned under `clip`, 436 pixels off the top under either of the
  // other two.
  it("never uses hidden, auto or scroll, which would take the vertical axis with them", () => {
    for (const part of PAGE_AREA_CLIPS_SIDEWAYS_CLASS.split(" ")) {
      expect(part).not.toMatch(/^overflow(-[xy])?-(hidden|auto|scroll)$/);
    }
  });

  it("says the up and down axis stays visible rather than leaving it to be worked out", () => {
    expect(PAGE_AREA_CLIPS_SIDEWAYS_CLASS.split(" ")).toContain("overflow-y-visible");
  });
});
