import { describe, expect, it } from "vitest";
import {
  ABOVE_MOBILE_BOTTOM_NAV_CLASS,
  APP_NAV_WIDTH_PROPERTY,
  CLEAR_OF_PHONE_LAUNCHER_CLASS,
  CLIPPY_LAUNCHER_RIGHT_CLASS,
  CLIPPY_LAUNCHER_SIZE_CLASS,
  FILLS_OR_KEEPS_HEIGHT_CLASS,
  MOBILE_BOTTOM_NAV_HEIGHT_CLASS,
  MOBILE_BOTTOM_NAV_ROOM,
  MOBILE_BOTTOM_NAV_ROOM_PROPERTY,
  OWN_LINE_ACTIONS_CLASS,
  PAGE_AREA_CLIPS_SIDEWAYS_CLASS,
  PAGE_AREA_CONTAINER_CLASS,
  PAGE_BOTTOM_BAR_CENTER_CLASS,
  PAGE_BOTTOM_BAR_FLOATING_CLASS,
  PAGE_BOTTOM_BAR_FLUSH_CLASS,
  PAGE_CORNER_NOTICE_CLASS,
  PAGE_CORNER_RIGHT_CLASS,
  PAGE_END_ROOM_CLASS,
  PAGE_END_ROOM_EXTRA_PX,
  PAGE_SCROLL_BOX_END_ROOM_CLASS,
  PAGE_SCROLL_BUTTON_SIZE_CLASS,
  PHONE_MESSAGE_BODY_HEIGHT_CLASS,
  PHONE_PAGE_END_ROOM_CLASS,
  RIGHT_INSET_PROPERTY,
  SCROLL_AREA_FITS_COLUMN_CLASS,
  SCROLL_TO_BOTTOM_OFFSET_CLASS,
  SCROLL_TO_TOP_OFFSET_CLASS,
  TOAST_STACK_MAX_HEIGHT_CLASS,
  TOAST_VIEWPORT_DESKTOP_CLASS,
  TOAST_VIEWPORT_PHONE_CLASS,
  WRAPPING_ROW_CLASS,
  pageBottomBarFlushPadding,
  pageNeedsEndRoom,
  spacingClassPixels,
} from "./narrow-layout";
import { PAGE_BOTTOM_BAR_END_ROOM_PROPERTY, PAGE_BOTTOM_BAR_ROOM_PROPERTY } from "./page-bottom-bar";

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

/**
 * What a length is worked out against: the bottom safe area, how far up the
 * window the bars along the bottom reach, and how far up the phone bottom bar
 * reaches (nothing on a desktop, where Layout publishes none).
 */
interface LengthAt {
  safeArea: number;
  barRoom: number;
  navRoom?: number;
  endRoom?: number;
  /** How far a row ends in from the right edge of the window. */
  rightInset?: number;
}

/**
 * The pixels behind a CSS length made of max(), calc() sums and differences,
 * rem and px, the safe area and the published rooms.
 */
function lengthPixels(written: string, at: LengthAt): number {
  // An underscore is how a Tailwind class writes a space.
  const value = written.replace(/_/g, " ").trim().replace(/,\s+/g, ",");
  const inside = (name: string) =>
    value.startsWith(`${name}(`) && value.endsWith(")") ? value.slice(name.length + 1, -1) : null;
  const largest = inside("max");
  if (largest !== null) {
    return Math.max(...splitOutsideBrackets(largest, ",").map((argument) => lengthPixels(argument, at)));
  }
  const sum = inside("calc");
  if (sum !== null) {
    // Terms joined by + or by a spaced -, outside brackets.
    let total = 0;
    let sign = 1;
    let depth = 0;
    let start = 0;
    for (let index = 0; index < sum.length; index += 1) {
      const character = sum[index];
      if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
      else if (depth === 0 && (character === "+" || (character === "-" && sum[index - 1] === " " && sum[index + 1] === " "))) {
        total += sign * lengthPixels(sum.slice(start, index), at);
        sign = character === "+" ? 1 : -1;
        start = index + 1;
      }
    }
    return total + sign * lengthPixels(sum.slice(start), at);
  }
  if (value === "env(safe-area-inset-bottom)") return at.safeArea;
  if (value === `var(${PAGE_BOTTOM_BAR_ROOM_PROPERTY},0px)`) return at.barRoom;
  if (value === `var(${MOBILE_BOTTOM_NAV_ROOM_PROPERTY},0px)`) return at.navRoom ?? 0;
  if (value === `var(${PAGE_BOTTOM_BAR_END_ROOM_PROPERTY},0px)`) return at.endRoom ?? 0;
  if (value === `var(${RIGHT_INSET_PROPERTY},0px)`) return at.rightInset ?? 0;
  const length = /^(\d+(?:\.\d+)?)(rem|px)$/.exec(value);
  if (length) return Number(length[1]) * (length[2] === "rem" ? 16 : 1);
  throw new Error(`cannot work out "${value}"`);
}

/**
 * How far up from the bottom of the window a `bottom-` class puts a control,
 * in pixels, worked out as the browser would for a bottom safe area and a
 * page's bottom bar reaching a given height up the window.
 */
function bottomPixels(bottomClass: string, at: LengthAt): number {
  const value = /^bottom-\[(.+)\]$/.exec(bottomClass)?.[1];
  return value === undefined ? spacingClassPixels(bottomClass) : lengthPixels(value, at);
}

/** The arbitrary value of the one class in a list that sets a property, as in `bottom-[...]`. */
function valueOf(classes: string, property: string): string {
  const part = classes.split(" ").find((candidate) => candidate.startsWith(`${property}-[`));
  expect(part, `no ${property} in "${classes}"`).toBeDefined();
  return part!.slice(property.length + 2, -1);
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

describe("where the toasts sit on a phone", () => {
  // At bottom-3 a message covered the whole bottom bar from the highest layer
  // there is, so while it showed none of its six destinations could be
  // reached. On a phone the bars along the bottom include the bottom bar
  // itself (MobileBottomNav registers), so with nothing else there the room
  // is the bottom bar's own.
  const SAFE_AREA = 34;
  const NAV_ROOM = 64 + SAFE_AREA;
  const phone = (barRoom: number) =>
    bottomPixels(partFor(TOAST_VIEWPORT_PHONE_CLASS, "", "bottom"), { safeArea: SAFE_AREA, barRoom });

  it("sits 0.75rem above the bottom bar, not on it", () => {
    expect(phone(NAV_ROOM)).toBe(NAV_ROOM + 12);
  });

  it("stays clear of where the bottom bar comes back, while it has slid away", () => {
    expect(phone(0)).toBe(NAV_ROOM + 12);
  });

  it("sits 0.75rem above a page's bar resting on the bottom bar, not that bar's height on top of the bottom bar's", () => {
    expect(phone(NAV_ROOM + 48)).toBe(NAV_ROOM + 48 + 12);
  });

  it("stops short of the corner the Clippy launcher stands in", () => {
    // Up there a message the width of the screen lay over the round launcher,
    // which is 1rem in from the right edge (ClippyLauncher) and this wide.
    const launcherReach = 16 + spacingClassPixels(partFor(CLIPPY_LAUNCHER_SIZE_CLASS, "", "size"));
    expect(spacingClassPixels(partFor(TOAST_VIEWPORT_PHONE_CLASS, "", "right"))).toBeGreaterThan(launcherReach);
    // And still held in from the left, so the box has both its edges.
    expect(spacingClassPixels(partFor(TOAST_VIEWPORT_PHONE_CLASS, "", "left"))).toBe(12);
  });

  it("goes back to the desktop place from md up, where the bottom bar is hidden", () => {
    for (const property of ["left", "right", "bottom"]) {
      partFor(TOAST_VIEWPORT_DESKTOP_CLASS, "md", property);
    }
  });

  it("lets the pile of messages grow only as far as the top of the window, from wherever its foot is", () => {
    // A failure stays until it is closed, so they pile up. Measured from the
    // old foot, the pile on a phone would have run off the top by the height
    // of the bottom bar, taking the oldest message, and the reason it gives,
    // with it.
    const parts = TOAST_STACK_MAX_HEIGHT_CLASS.split(" ");
    expect(parts).toContain(`max-h-[calc(100dvh-0.75rem-${valueOf(TOAST_VIEWPORT_PHONE_CLASS, "bottom")})]`);
    expect(parts).toContain(`md:max-h-[calc(100dvh-1.5rem-var(${PAGE_BOTTOM_BAR_ROOM_PROPERTY},0px))]`);
  });
});

describe("a page's own notice in the bottom right corner", () => {
  // In the launcher's own place on a phone it lay over the round launcher
  // for the four to six seconds it showed.
  it("sits where the toasts do on a phone: above the bottom bar, beside the launcher", () => {
    for (const property of ["right", "bottom"]) {
      expect(partFor(PAGE_CORNER_NOTICE_CLASS, "", property)).toBe(partFor(TOAST_VIEWPORT_PHONE_CLASS, "", property));
    }
  });

  it("sits in the corner from md up, moved in by docked Clippy and above a page's own bar", () => {
    expect(PAGE_CORNER_NOTICE_CLASS.split(" ")).toContain(`md:${PAGE_CORNER_RIGHT_CLASS}`);
    expect(partFor(PAGE_CORNER_NOTICE_CLASS, "md", "bottom")).toBe(partFor(ABOVE_MOBILE_BOTTOM_NAV_CLASS, "md", "bottom"));
  });
});

describe("a row of buttons the round launcher floats beside on a phone", () => {
  const WINDOW = 390;
  /** How far in from the right edge of the window the launcher reaches: its offset and its width. */
  const launcherReach =
    spacingClassPixels(CLIPPY_LAUNCHER_RIGHT_CLASS) + spacingClassPixels(partFor(CLIPPY_LAUNCHER_SIZE_CLASS, "", "size"));
  const room = (rightInset: number) =>
    lengthPixels(valueOf(CLEAR_OF_PHONE_LAUNCHER_CLASS, "max-md:pr"), { safeArea: 0, barRoom: 0, rightInset });

  it("ends its last button half a rem clear of the launcher, however far in the row ends", () => {
    // The launcher covered the right end of the reply box's Send button,
    // whose row ends 50 pixels in on a 390 pixel phone.
    expect(launcherReach).toBe(64);
    for (const rightInset of [0, 16, 50, 64]) {
      const lastButtonEnds = WINDOW - rightInset - room(rightInset);
      expect(lastButtonEnds, `a row ending ${rightInset} pixels in`).toBe(WINDOW - launcherReach - 8);
    }
  });

  it("keeps no room once the row already ends clear of the launcher", () => {
    expect(room(launcherReach + 8)).toBe(0);
    expect(room(120)).toBe(0);
  });

  it("is room at the right of the row, on a phone only", () => {
    expect(CLEAR_OF_PHONE_LAUNCHER_CLASS.startsWith("max-md:pr-[")).toBe(true);
    expect(CLEAR_OF_PHONE_LAUNCHER_CLASS).not.toContain(" ");
  });
});

describe("the room a phone keeps at the end of the page", () => {
  const SAFE_AREA = 34;
  const endPadding = (endRoom: number) =>
    lengthPixels(valueOf(PHONE_PAGE_END_ROOM_CLASS, "pb"), { safeArea: SAFE_AREA, barRoom: 0, endRoom });
  /** Where the round launcher's top is, with the bars along the bottom reaching this far up. */
  const launcherTop = (barRoom: number) =>
    bottomPixels(partFor(ABOVE_MOBILE_BOTTOM_NAV_CLASS, "", "bottom"), { safeArea: SAFE_AREA, barRoom }) +
    spacingClassPixels(partFor(CLIPPY_LAUNCHER_SIZE_CLASS, "", "size"));

  it("ends the page a rem clear of the round launcher", () => {
    // At 5rem the launcher sat on the Wake button of the last card on Team.
    expect(endPadding(0)).toBe(launcherTop(0) + 16);
  });

  it("reaches past a bar fixed over the page, and the launcher sitting above that bar", () => {
    // Two rows of selection buttons, 118 pixels, resting 24 pixels above the
    // bottom bar and its safe area hid the end of the portfolio issues list.
    const endRoom = 65 + SAFE_AREA + 24 + 118;
    expect(endPadding(endRoom)).toBe(launcherTop(endRoom) + 16);
  });

  it("is padding at the end of the page area, on a phone only", () => {
    expect(PHONE_PAGE_END_ROOM_CLASS.startsWith("pb-[")).toBe(true);
    expect(PHONE_PAGE_END_ROOM_CLASS).not.toContain(" ");
    expect(PHONE_PAGE_END_ROOM_CLASS).not.toContain("md:");
  });
});

describe("the padding under a bar that runs along the edge", () => {
  const padding = (own: string, navRoom: number) =>
    lengthPixels(pageBottomBarFlushPadding(own), { safeArea: 34, barRoom: 0, navRoom });

  it("is the bar's own while the phone bottom bar shows and holds the safe area", () => {
    expect(padding("0.5rem", 64 + 34)).toBe(8);
    expect(padding("0.75rem", 64 + 34)).toBe(12);
  });

  it("clears the safe area once the bottom bar has slid away", () => {
    // Without it, an iPhone's home bar sat over the pipeline stage's Save button.
    expect(padding("0.75rem", 0)).toBe(34);
  });

  it("is the bar's own where there is no safe area", () => {
    expect(lengthPixels(pageBottomBarFlushPadding("0.5rem"), { safeArea: 0, barRoom: 0 })).toBe(8);
  });
});

describe("how far up the phone bottom bar reaches", () => {
  // Layout publishes it for a page's own bar to rest on. It has to be the
  // bar's own height, or a bar resting on it leaves a gap or sits on its
  // buttons.
  it("is the bottom bar's height and the safe area under it", () => {
    expect(MOBILE_BOTTOM_NAV_ROOM_PROPERTY).toBe("--mobile-bottom-nav-room");
    expect(lengthPixels(MOBILE_BOTTOM_NAV_ROOM, { safeArea: 34, barRoom: 0 })).toBe(
      spacingClassPixels(MOBILE_BOTTOM_NAV_HEIGHT_CLASS) + 34,
    );
  });
});

describe("a page's own bar along the bottom", () => {
  // At bottom-0 the agent Save bar sat under the phone bottom bar, which is
  // drawn later on the same layer, so Save could not be pressed. At bottom-6
  // the selection bars sat over it and hid its middle buttons.
  const SAFE_AREA = 34;
  const NAV_ROOM = 64 + SAFE_AREA;
  const flush = (at: LengthAt) => bottomPixels(partFor(PAGE_BOTTOM_BAR_FLUSH_CLASS, "", "bottom"), at);
  const floating = (at: LengthAt) => bottomPixels(partFor(PAGE_BOTTOM_BAR_FLOATING_CLASS, "", "bottom"), at);

  it("rests on top of the phone bottom bar while it shows", () => {
    expect(flush({ safeArea: SAFE_AREA, barRoom: 0, navRoom: NAV_ROOM })).toBe(NAV_ROOM);
    expect(floating({ safeArea: SAFE_AREA, barRoom: 0, navRoom: NAV_ROOM })).toBe(NAV_ROOM + 24);
  });

  it("goes down with it when it slides away, the floating one still clear of the safe area", () => {
    expect(flush({ safeArea: SAFE_AREA, barRoom: 0, navRoom: 0 })).toBe(0);
    expect(floating({ safeArea: SAFE_AREA, barRoom: 0, navRoom: 0 })).toBe(SAFE_AREA + 24);
  });

  it("sits where it always did on a desktop, where no bottom bar is published", () => {
    expect(flush({ safeArea: 0, barRoom: 0 })).toBe(spacingClassPixels("bottom-0"));
    expect(floating({ safeArea: 0, barRoom: 0 })).toBe(spacingClassPixels("bottom-6"));
  });

  it("slides with the bottom bar rather than jumping", () => {
    // The bottom bar slides over 200ms (MobileBottomNav).
    for (const placement of [PAGE_BOTTOM_BAR_FLUSH_CLASS, PAGE_BOTTOM_BAR_FLOATING_CLASS]) {
      expect(placement.split(" ")).toEqual(expect.arrayContaining(["transition-[bottom]", "duration-200"]));
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

  it("is never wider than the window, and wraps its buttons instead", () => {
    // On a phone the portfolio issues bar ran past both edges of the screen,
    // cutting off its count and its Deselect button. Placed at the middle of
    // the window, a bar is only given the right half of it unless it asks for
    // its own width (w-max).
    expect(PAGE_BOTTOM_BAR_CENTER_CLASS.split(" ")).toEqual(
      expect.arrayContaining(["w-max", "max-w-[calc(100vw-1.5rem)]", "flex-wrap"]),
    );
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
    expect(pageNeedsEndRoom({ scrollHeight: 1400, clientHeight: 800 }, 0)).toBe(true);
    // A page that fills the area exactly, such as Skill Studio, keeps its height.
    expect(pageNeedsEndRoom({ scrollHeight: 800, clientHeight: 800 }, 0)).toBe(false);
  });

  it("does not switch itself on and off once added", () => {
    // Overflowing only because of the room itself: the page fits without it.
    expect(pageNeedsEndRoom({ scrollHeight: 800 + PAGE_END_ROOM_EXTRA_PX - 10, clientHeight: 800 }, PAGE_END_ROOM_EXTRA_PX)).toBe(false);
    // Still longer than the area without the room: keep it.
    expect(pageNeedsEndRoom({ scrollHeight: 1400 + PAGE_END_ROOM_EXTRA_PX, clientHeight: 800 }, PAGE_END_ROOM_EXTRA_PX)).toBe(true);
    // The room is taller while a bar is fixed over the page, and all of it comes off.
    expect(pageNeedsEndRoom({ scrollHeight: 800 + PAGE_END_ROOM_EXTRA_PX + 74 - 10, clientHeight: 800 }, PAGE_END_ROOM_EXTRA_PX + 74)).toBe(false);
  });

  it("ends the page clear of the launcher standing above a bar fixed over the page", () => {
    // With a selection bar up the pill stands above the bar, and sat on the
    // end of the last row. The bars reach 74 pixels up at 1280 pixels across.
    const height = PAGE_END_ROOM_CLASS.split(" ").find((part) => part.includes("after:h-"))!.split(":").pop()!;
    for (const barsReach of [0, 74, 140]) {
      const pageEnds = 24 + lengthPixels(height.slice("h-[".length, -1), { safeArea: 0, barRoom: barsReach, endRoom: barsReach });
      const launcherTop =
        bottomPixels(partFor(ABOVE_MOBILE_BOTTOM_NAV_CLASS, "md", "bottom"), { safeArea: 0, barRoom: barsReach }) +
        spacingClassPixels(partFor(CLIPPY_LAUNCHER_SIZE_CLASS, "md", "h"));
      expect(pageEnds, `bars reaching ${barsReach} pixels up`).toBe(launcherTop + 16);
    }
  });
});

describe("room at the end of a page's own scrolling box", () => {
  // Portfolio issues scrolls a box inside the page area, so the page area's
  // room never came on and the pill sat on the end of its last row.
  it("is the same block as the page area's, there whenever the box is, from md up", () => {
    const areaHeight = PAGE_END_ROOM_CLASS.split(" ").find((part) => part.includes("after:h-"))!.split(":").pop();
    const boxParts = PAGE_SCROLL_BOX_END_ROOM_CLASS.split(" ");
    expect(boxParts).toContain(`md:after:${areaHeight}`);
    expect(boxParts).toContain("md:after:block");
    for (const part of boxParts) expect(part.startsWith("md:after:")).toBe(true);
  });

  it("does not shrink away in a box that lays its rows out as a flex column", () => {
    expect(PAGE_SCROLL_BOX_END_ROOM_CLASS.split(" ")).toContain("md:after:shrink-0");
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
