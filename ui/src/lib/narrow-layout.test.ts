import { describe, expect, it } from "vitest";
import {
  ABOVE_MOBILE_BOTTOM_NAV_CLASS,
  APP_NAV_WIDTH_PROPERTY,
  CLIPPY_LAUNCHER_SIZE_CLASS,
  FILLS_OR_KEEPS_HEIGHT_CLASS,
  MOBILE_BOTTOM_NAV_HEIGHT_CLASS,
  OWN_LINE_ACTIONS_CLASS,
  PAGE_AREA_CLIPS_SIDEWAYS_CLASS,
  PAGE_AREA_CONTAINER_CLASS,
  PAGE_BOTTOM_BAR_CENTER_CLASS,
  PAGE_CORNER_RIGHT_CLASS,
  PAGE_END_ROOM_CLASS,
  PAGE_END_ROOM_EXTRA_PX,
  PAGE_SCROLL_BUTTON_SIZE_CLASS,
  PHONE_MESSAGE_BODY_HEIGHT_CLASS,
  SCROLL_AREA_FITS_COLUMN_CLASS,
  SCROLL_TO_BOTTOM_OFFSET_CLASS,
  SCROLL_TO_TOP_OFFSET_CLASS,
  TOAST_VIEWPORT_DESKTOP_CLASS,
  WRAPPING_ROW_CLASS,
  pageNeedsEndRoom,
  spacingClassPixels,
} from "./narrow-layout";
import { PAGE_BOTTOM_BAR_ROOM_PROPERTY } from "./page-bottom-bar";

/** The part of a responsive class string for one breakpoint: "" for phones, "md" for desktop. */
function partFor(classes: string, breakpoint: "" | "md", property: string): string {
  const part = classes.split(" ").find((candidate) => {
    const [prefix, rest] = candidate.includes(":") ? candidate.split(":") : ["", candidate];
    return prefix === breakpoint && rest!.startsWith(`${property}-`);
  });
  expect(part, `no ${breakpoint || "phone"} ${property} in "${classes}"`).toBeDefined();
  return part!.replace(/^md:/, "");
}

/** Splits a CSS value on a separator, outside any brackets. */
function splitOutsideBrackets(value: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === separator && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

/** The pixels behind a CSS length made of max(), calc() sums, rem and px, the safe area and a bar's room. */
function lengthPixels(value: string, at: { safeArea: number; barRoom: number }): number {
  const inside = (name: string) =>
    value.startsWith(`${name}(`) && value.endsWith(")") ? value.slice(name.length + 1, -1) : null;
  const largest = inside("max");
  if (largest !== null) {
    return Math.max(...splitOutsideBrackets(largest, ",").map((argument) => lengthPixels(argument, at)));
  }
  const sum = inside("calc");
  if (sum !== null) {
    return splitOutsideBrackets(sum, "+").reduce((total, term) => total + lengthPixels(term, at), 0);
  }
  if (value === "env(safe-area-inset-bottom)") return at.safeArea;
  if (value === `var(${PAGE_BOTTOM_BAR_ROOM_PROPERTY},0px)`) return at.barRoom;
  const length = /^(\d+(?:\.\d+)?)(rem|px)$/.exec(value);
  if (length) return Number(length[1]) * (length[2] === "rem" ? 16 : 1);
  throw new Error(`cannot work out "${value}"`);
}

/**
 * How far up from the bottom of the window a `bottom-` class puts a control,
 * in pixels, worked out as the browser would for a bottom safe area and a
 * page's bottom bar reaching a given height up the window.
 */
function bottomPixels(bottomClass: string, at: { safeArea: number; barRoom: number }): number {
  const value = /^bottom-\[(.+)\]$/.exec(bottomClass)?.[1];
  return value === undefined ? spacingClassPixels(bottomClass) : lengthPixels(value, at);
}

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
    // breakpoint or every desktop window keeps a gap it does not need. The
    // desktop half is the ordinary 1rem corner, plus a page bottom bar's room
    // when there is one (which is nothing otherwise).
    const desktop = partFor(ABOVE_MOBILE_BOTTOM_NAV_CLASS, "md", "bottom");
    expect(spacingClassPixels(desktop)).toBe(16);
    expect(desktop).toContain(`var(${PAGE_BOTTOM_BAR_ROOM_PROPERTY},0px)`);
  });
});

describe("the corner controls above a page's own bottom bar", () => {
  // The launcher sat on the agent Save bar. A page's bottom bar now publishes
  // the room it takes (lib/page-bottom-bar), and everything that floats along
  // the bottom adds that room, with nothing as the fallback when no bar is
  // there, so the CSS variable check never flags it as undefined.
  const room = `var(${PAGE_BOTTOM_BAR_ROOM_PROPERTY},0px)`;

  it("lifts the launcher, on a phone and on a desktop", () => {
    expect(partFor(ABOVE_MOBILE_BOTTOM_NAV_CLASS, "", "bottom")).toContain(room);
    expect(partFor(ABOVE_MOBILE_BOTTOM_NAV_CLASS, "md", "bottom")).toContain(room);
  });

  it("lifts both scroll buttons by the same room, so the column above the launcher stays together", () => {
    for (const offset of [SCROLL_TO_BOTTOM_OFFSET_CLASS, SCROLL_TO_TOP_OFFSET_CLASS]) {
      expect(partFor(offset, "", "bottom")).toContain(room);
      expect(partFor(offset, "md", "bottom")).toContain(room);
    }
  });

  it("lifts the toasts on a desktop too", () => {
    expect(TOAST_VIEWPORT_DESKTOP_CLASS).toContain(`md:bottom-[calc(0.75rem+${room})]`);
  });
});

describe("where the launcher and the scroll buttons sit with a page's bottom bar", () => {
  // An iPhone's bottom safe area, and the reply box that sticks to the foot
  // of the issue chat, whose top is about 216 pixels up the window.
  const SAFE_AREA = 34;
  const CHAT_REPLY_BOX = 216;
  const phone = (classes: string, barRoom: number) =>
    bottomPixels(partFor(classes, "", "bottom"), { safeArea: SAFE_AREA, barRoom });
  const desktop = (classes: string, barRoom: number) =>
    bottomPixels(partFor(classes, "md", "bottom"), { safeArea: 0, barRoom });

  it("keeps the launcher clear of the phone's bottom bar and the safe area when the page has no bar", () => {
    expect(phone(ABOVE_MOBILE_BOTTOM_NAV_CLASS, 0)).toBe(80 + SAFE_AREA);
  });

  it("puts the launcher 1rem above a page's bar on a phone, not the bar's height on top of the bottom bar's room", () => {
    // Added up, it rose from 114 to 80 + 34 + 216 = 330 pixels on the issue
    // chat, over the messages.
    expect(phone(ABOVE_MOBILE_BOTTOM_NAV_CLASS, CHAT_REPLY_BOX)).toBe(CHAT_REPLY_BOX + 16);
  });

  it("counts the safe area once on a phone, since a bar's room is measured from the bottom of the window", () => {
    // A bar low enough to be under the launcher's usual place leaves it there.
    expect(phone(ABOVE_MOBILE_BOTTOM_NAV_CLASS, 60)).toBe(80 + SAFE_AREA);
  });

  it("puts scroll-to-top just above the column, not over the chat's messages", () => {
    // 216 up for the reply box, 1rem to the launcher, then the column above it.
    expect(phone(SCROLL_TO_TOP_OFFSET_CLASS, CHAT_REPLY_BOX)).toBe(CHAT_REPLY_BOX + 16 + 104);
  });

  it("keeps the scroll buttons the same distance above the launcher, with a bar and without", () => {
    for (const barRoom of [0, 60, CHAT_REPLY_BOX, 400]) {
      const launcher = phone(ABOVE_MOBILE_BOTTOM_NAV_CLASS, barRoom);
      // The 3rem launcher and a 0.75rem gap, then a 2.25rem button and a 0.5rem gap.
      expect(phone(SCROLL_TO_BOTTOM_OFFSET_CLASS, barRoom) - launcher).toBe(60);
      expect(phone(SCROLL_TO_TOP_OFFSET_CLASS, barRoom) - launcher).toBe(104);

      const desktopLauncher = desktop(ABOVE_MOBILE_BOTTOM_NAV_CLASS, barRoom);
      // The 2.5rem pill and a 0.75rem gap, then the same button and gap.
      expect(desktop(SCROLL_TO_BOTTOM_OFFSET_CLASS, barRoom) - desktopLauncher).toBe(52);
      expect(desktop(SCROLL_TO_TOP_OFFSET_CLASS, barRoom) - desktopLauncher).toBe(96);
    }
  });

  it("puts the launcher 1rem above a page's bar on a desktop, as before", () => {
    expect(desktop(ABOVE_MOBILE_BOTTOM_NAV_CLASS, 0)).toBe(16);
    expect(desktop(ABOVE_MOBILE_BOTTOM_NAV_CLASS, 70)).toBe(86);
  });
});

describe("where the toasts sit on a desktop", () => {
  // At the left edge of the window a message covered the account button at
  // the foot of the navigation, and the add-company button under the rail.
  it("starts beside the rail and the navigation, by the width Layout publishes", () => {
    expect(APP_NAV_WIDTH_PROPERTY).toBe("--app-nav-width");
    expect(TOAST_VIEWPORT_DESKTOP_CLASS).toContain(`md:left-[calc(var(${APP_NAV_WIDTH_PROPERTY},0px)+0.75rem)]`);
  });

  it("only moves on a desktop, where the navigation is beside the page rather than a drawer", () => {
    for (const part of TOAST_VIEWPORT_DESKTOP_CLASS.split(" ")) {
      expect(part.startsWith("md:")).toBe(true);
    }
  });
});

describe("a page's own floating element in the bottom right corner", () => {
  // Placed against the window, `right-4` put it under docked Clippy, on a
  // higher layer: the agent Save and Cancel bar could not be seen at all.
  it("moves in by docked Clippy's width", () => {
    expect(PAGE_CORNER_RIGHT_CLASS).toBe("right-[calc(var(--clippy-dock-width,0px)+1rem)]");
  });
});

describe("a page's own bar centred along the bottom", () => {
  // Centred on the window, the portfolio issues selection bar ran under
  // docked Clippy at 1280 wide and lost its Deselect button.
  it("centres between the navigation and docked Clippy", () => {
    expect(PAGE_BOTTOM_BAR_CENTER_CLASS).toContain("var(--app-nav-width,0px)");
    expect(PAGE_BOTTOM_BAR_CENTER_CLASS).toContain("var(--clippy-dock-width,0px)");
    expect(PAGE_BOTTOM_BAR_CENTER_CLASS.split(" ")).toContain("-translate-x-1/2");
  });

  it("stays in the middle of the window without Clippy docked, where it always was", () => {
    // Without the dock the page-area centre is right of the window centre, so
    // `min` with 50% keeps the old place.
    expect(PAGE_BOTTOM_BAR_CENTER_CLASS).toMatch(/^left-\[min\(50%,/);
  });
});

describe("the page area as a size container", () => {
  // Pages measured themselves against the window, so docked Clippy, which
  // takes 420 pixels from the page without the window getting narrower,
  // left four stat cards in four columns of about 150 pixels.
  it("is a container pages can query with @md:, @2xl: and the rest", () => {
    expect(PAGE_AREA_CONTAINER_CLASS).toBe("@container");
  });
});

describe("room at the end of a page that scrolls", () => {
  it("ends the page clear of the launcher, by a rem", () => {
    // The page area's own md:p-6 is 24 pixels; the launcher reaches up to
    // its 1rem corner offset plus its 2.5rem height.
    const launcherTop =
      spacingClassPixels(partFor(ABOVE_MOBILE_BOTTOM_NAV_CLASS, "md", "bottom")) +
      spacingClassPixels(partFor(CLIPPY_LAUNCHER_SIZE_CLASS, "md", "h"));
    expect(24 + PAGE_END_ROOM_EXTRA_PX).toBeGreaterThanOrEqual(launcherTop + 16);
  });

  it("adds a block after the page rather than padding, which would lift a bar that sticks to the bottom", () => {
    expect(PAGE_END_ROOM_CLASS).not.toContain("pb-");
    const height = PAGE_END_ROOM_CLASS.split(" ").find((part) => part.includes("after:h-"));
    expect(height).toBeDefined();
    expect(spacingClassPixels(height!.split(":").pop()!)).toBe(PAGE_END_ROOM_EXTRA_PX);
  });

  it("only applies on a desktop, and only while Layout marks the page as scrolling", () => {
    for (const part of PAGE_END_ROOM_CLASS.split(" ")) {
      expect(part.startsWith("md:data-[page-end-room=true]:")).toBe(true);
    }
  });

  it("is needed by a page longer than the page area, and not by one that fits it", () => {
    expect(pageNeedsEndRoom({ scrollHeight: 1400, clientHeight: 800 }, false)).toBe(true);
    // A page that fills the area exactly, such as Skill Studio, keeps its height.
    expect(pageNeedsEndRoom({ scrollHeight: 800, clientHeight: 800 }, false)).toBe(false);
  });

  it("does not switch itself on and off once added", () => {
    // Overflowing only because of the room itself: the page fits without it.
    expect(pageNeedsEndRoom({ scrollHeight: 800 + PAGE_END_ROOM_EXTRA_PX - 10, clientHeight: 800 }, true)).toBe(false);
    // Still longer than the area without the room: keep it.
    expect(pageNeedsEndRoom({ scrollHeight: 1400 + PAGE_END_ROOM_EXTRA_PX, clientHeight: 800 }, true)).toBe(true);
  });
});

describe("the page scroll buttons above the Clippy launcher", () => {
  // The round launcher left room for the scroll buttons to its left. The
  // "Ask Clippy anything" pill is wider than that room, so the buttons stack
  // above it instead, and these numbers live in one file so they agree.
  for (const breakpoint of ["", "md"] as const) {
    const name = breakpoint ? "on a desktop" : "on a phone";

    it(`puts scroll-to-bottom clear above the launcher ${name}`, () => {
      const launcherBottom = spacingClassPixels(partFor(ABOVE_MOBILE_BOTTOM_NAV_CLASS, breakpoint, "bottom"));
      const launcherHeight = breakpoint
        ? spacingClassPixels(partFor(CLIPPY_LAUNCHER_SIZE_CLASS, "md", "h"))
        : spacingClassPixels(partFor(CLIPPY_LAUNCHER_SIZE_CLASS, "", "size"));
      const buttonBottom = spacingClassPixels(partFor(SCROLL_TO_BOTTOM_OFFSET_CLASS, breakpoint, "bottom"));
      expect(buttonBottom).toBeGreaterThan(launcherBottom + launcherHeight);
    });

    it(`puts scroll-to-top clear above scroll-to-bottom ${name}`, () => {
      const buttonHeight = spacingClassPixels(PAGE_SCROLL_BUTTON_SIZE_CLASS.replace("size-", "h-"));
      const lower = spacingClassPixels(partFor(SCROLL_TO_BOTTOM_OFFSET_CLASS, breakpoint, "bottom"));
      const upper = spacingClassPixels(partFor(SCROLL_TO_TOP_OFFSET_CLASS, breakpoint, "bottom"));
      expect(upper).toBeGreaterThan(lower + buttonHeight);
    });
  }
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
