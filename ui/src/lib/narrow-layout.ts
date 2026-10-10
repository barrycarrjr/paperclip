/**
 * Layout rules that keep controls reachable when the window is narrow.
 *
 * These are Tailwind class strings rather than numbers because Tailwind needs
 * to see the literal in the source to generate the rule. Import the constant
 * instead of typing the classes inline, so the two halves of each rule (the
 * bar's height and the space kept clear above it; the row that wraps and the
 * row it wraps inside) cannot drift apart in two files that have no reason to
 * know about each other.
 *
 * Both rules come from the same kind of fault, found in the narrow-width audit
 * on 2026-09-08: a control that is drawn but cannot be pressed. One was covered
 * by something on a higher layer, the other was cut off by the edge of its
 * card. Neither showed up as an error anywhere.
 */

/** Height of the phone bottom bar itself. */
export const MOBILE_BOTTOM_NAV_HEIGHT_CLASS = "h-16";

/**
 * Bottom offset for a floating control that has to stay above the phone bottom
 * bar, dropping back to the ordinary corner offset once the bar is gone. The
 * bar is `md:hidden`, so the `md:` half here has to match that breakpoint.
 *
 * The round Clippy launcher was pinned at `bottom-4` on a higher layer than the
 * bar, so on a phone it sat exactly on top of the last button in the bar and
 * that button could not be tapped at all: every tap opened Clippy instead.
 *
 * Both halves also make room for `--page-bottom-bar-room`, how far up from
 * the bottom of the window a bar a page pins there reaches (lib/page-bottom-bar),
 * so the control sits above that bar rather than on it: the pill sat on the
 * agent Save bar. On a desktop that is the ordinary 1rem above the bar.
 *
 * On a phone it is the higher of the two places, 1rem above the bar or clear
 * of the bottom bar and the safe area, not both added up. The 5rem already
 * keeps the launcher clear of the phone's bottom bar, and the bar's room is
 * measured from the bottom of the window, so it holds the safe area already.
 * Added up, the launcher rose from about 114 to about 330 pixels on the issue
 * chat, and scroll-to-top landed over the messages.
 */
export const ABOVE_MOBILE_BOTTOM_NAV_CLASS =
  "bottom-[max(calc(5rem+env(safe-area-inset-bottom)),calc(var(--page-bottom-bar-room,0px)+1rem))] md:bottom-[calc(1rem+var(--page-bottom-bar-room,0px))]";

/**
 * Size of the Clippy launcher: a round 48 pixel button on a phone, and from
 * `md` up a 40 pixel tall "Ask Clippy anything" pill. It sits at
 * {@link ABOVE_MOBILE_BOTTOM_NAV_CLASS} in the bottom right corner.
 */
export const CLIPPY_LAUNCHER_SIZE_CLASS = "size-12 md:h-10 md:w-auto";

/** Size of the round scroll-to-top and scroll-to-bottom buttons on long pages. */
export const PAGE_SCROLL_BUTTON_SIZE_CLASS = "size-9";

/**
 * Where the page's scroll buttons sit: in a column above the Clippy
 * launcher, never beside it. The round launcher left room for them to its
 * left, 80 pixels in from the edge; the pill is wider than that, so they move
 * up instead. Each value starts with one rem length so the test can add them
 * up: on a phone the launcher's top is 5rem + 3rem, on a desktop 1rem + 2.5rem,
 * and each button is 2.25rem tall with a small gap above what it clears. They
 * make room for a page's bottom bar the same way the launcher does, the higher
 * of the two on a phone, so the whole column moves up together above the bar
 * and keeps its spacing.
 */
export const SCROLL_TO_BOTTOM_OFFSET_CLASS =
  "bottom-[max(calc(8.75rem+env(safe-area-inset-bottom)),calc(var(--page-bottom-bar-room,0px)+4.75rem))] md:bottom-[calc(4.25rem+var(--page-bottom-bar-room,0px))]";
export const SCROLL_TO_TOP_OFFSET_CLASS =
  "bottom-[max(calc(11.5rem+env(safe-area-inset-bottom)),calc(var(--page-bottom-bar-room,0px)+7.5rem))] md:bottom-[calc(7rem+var(--page-bottom-bar-room,0px))]";

/**
 * How far in from the right the scroll buttons sit: centred over the round
 * launcher on a phone, lined up with the pill's right edge from `md` up.
 * `--clippy-dock-width` is the width of Clippy when it is docked as a side
 * panel (0 otherwise), set on the document by ClippyWindow, so the buttons
 * move out from under the panel rather than being covered by it.
 */
export const PAGE_SCROLL_BUTTON_RIGHT_CLASS =
  "right-[1.375rem] md:right-[calc(var(--clippy-dock-width,0px)+1rem)]";

/** The same, while the 320 pixel properties panel is also showing on the right. */
export const PAGE_SCROLL_BUTTON_RIGHT_BESIDE_PANEL_CLASS =
  "md:right-[calc(var(--clippy-dock-width,0px)+320px+1rem)]";

/**
 * How far in from the right a page's own floating element sits when it is
 * meant for the bottom right corner, such as the Email page's short
 * "Archived" notice. A page's fixed elements are placed against the window,
 * so a plain `right-4` put them under Clippy whenever Clippy was docked as a
 * side panel, on a higher layer: the agent Save and Cancel bar, at `right-6`,
 * could not be seen or pressed at all. Anything a page fixes to the right
 * adds the docked width the same way the scroll buttons do; this is the
 * version at the ordinary corner offset.
 */
export const PAGE_CORNER_RIGHT_CLASS = "right-[calc(var(--clippy-dock-width,0px)+1rem)]";

/**
 * Centres a page's own bar along the bottom, such as the action bar that comes
 * up when rows are selected. Centred on the window, it ran under docked
 * Clippy: at 1280 wide the portfolio issues bar lost its Deselect button
 * under the panel. With Clippy docked it centres on the page area instead,
 * between the navigation (`--app-nav-width`) and the panel; without Clippy
 * `min` keeps it in the middle of the window, where it always was.
 */
export const PAGE_BOTTOM_BAR_CENTER_CLASS =
  "left-[min(50%,calc(var(--app-nav-width,0px)+(100%-var(--app-nav-width,0px)-var(--clippy-dock-width,0px))/2))] -translate-x-1/2";

/**
 * Where the toasts sit on a desktop: beside the company rail and the
 * navigation rather than on top of them, and above a page's own bottom bar.
 * At the left edge of the window they covered the account button at the
 * bottom of the navigation and the add-company button under the rail.
 * `--app-nav-width` is the width of those two columns, set by Layout
 * (APP_NAV_WIDTH_PROPERTY). On a phone the navigation is a drawer, so the
 * toasts keep their place there.
 */
export const APP_NAV_WIDTH_PROPERTY = "--app-nav-width";
export const TOAST_VIEWPORT_DESKTOP_CLASS =
  "md:left-[calc(var(--app-nav-width,0px)+0.75rem)] md:bottom-[calc(0.75rem+var(--page-bottom-bar-room,0px))]";

/**
 * Stops one page making the whole app slide sideways on a phone.
 *
 * On a phone the app lets the document scroll, so the page area is an ordinary
 * block and anything inside it that is too wide makes the document itself too
 * wide. The whole shell then slides, top bar and all, and the menu button and
 * the bottom bar go with it. The page does not have to be one of ours: the
 * Phone Wallboard page in the 3cx-tools plugin asks for panels of at least 360
 * pixels, and the narrow-width audit on 2026-09-08 measured the document at
 * 392 pixels against a 367 pixel page there. Plugins are released on their own
 * timetable, so the shell has to hold its shape whatever a plugin does.
 *
 * `clip`, and the up-and-down axis named separately, rather than `hidden` or
 * `auto`: CSS turns the other axis into `auto` the moment one axis is `hidden`
 * or `auto`, which would make the page area its own scrolling box. On a phone
 * the document is what scrolls, so that quietly changes the page. Measured in
 * the running app at 375 wide, a heading set to `position: sticky` stayed
 * pinned to the top of the screen under `clip` and scrolled 436 pixels off the
 * top under `hidden` and under `auto` alike. `clip` leaves the page area an
 * ordinary block that simply does not paint past its own edge.
 *
 * A page that scrolls sideways on purpose is untouched, because it carries its
 * own scrolling box inside the page area. The issue board still scrolled its
 * 1900 pixels of columns inside a 351 pixel strip with this in place.
 *
 * Desktop is not part of this rule: there the page area is already
 * `overflow-auto`, so a page that is too wide gets a scrollbar of its own and
 * the shell around it never moves.
 */
export const PAGE_AREA_CLIPS_SIDEWAYS_CLASS = "overflow-x-clip overflow-y-visible";

/**
 * Makes the page area a size container, so a page can shape itself to the
 * room it actually has with container queries (`@md:`, `@2xl:`, `@4xl:`)
 * instead of to the browser window (`md:`, `lg:`, `xl:`).
 *
 * The window is the wrong measure whenever something beside the page takes
 * part of it. Docked as a side panel, Clippy takes 420 pixels: at 1440 wide
 * the page has about 660 pixels left, the width it has at 1024 without
 * Clippy, yet every `xl:` rule still fired, so the Overview's four stat cards
 * sat in four columns of 150 pixels with their labels on two lines and their
 * second line cut off. The properties panel and the navigation take room the
 * same way. Measured against the page area, a layout changes where the page
 * runs out of room, whatever took it.
 *
 * `inline-size` measures the width only, so the page area still grows to its
 * content's height.
 *
 * In Chromium it does not make the page area the box that `fixed` elements
 * inside it are placed against: a fixed element inside it stayed where it was
 * against the window. Safari before 18.4 did (WebKit bugs 277122 and 284945),
 * so there a fixed element inside the page area was pinned to the page area,
 * not the screen: the agent Save bar sat at the end of the page. A page
 * therefore never fixes anything inside the page area. Its fixed bars, notices
 * and buttons go through PageFloating (components/PageFloatingLayer), which
 * draws them in a layer beside the page area, whatever the browser.
 */
export const PAGE_AREA_CONTAINER_CLASS = "@container";

/**
 * Room at the end of a page that scrolls, so its last row ends above the
 * Clippy launcher instead of under it. Scrolled to the end, the Pipelines "add
 * items" page put its Submit button exactly on the launcher's top edge: the
 * page area's 1.5rem of padding plus the page's own 2rem came to the 3.5rem
 * the launcher reaches up to. A 3rem block after the page brings the end to
 * at least 4.5rem up, clear of the launcher by a rem whatever the page's own
 * padding is.
 *
 * A block after the page rather than more padding: a bar that sticks to the
 * bottom of the page area stops at the area's padding, so more padding lifted
 * the Pipelines "unsaved changes" bar 72 pixels off the bottom of the window,
 * with the page showing underneath it.
 *
 * Only while the page is longer than the page area: Layout sets
 * `data-page-end-room` then (hooks/usePageEndRoom, pageNeedsEndRoom below). A
 * page that fills the area exactly, such as Skill Studio or the org chart,
 * keeps its full height, and a short page has room to spare already. On a
 * phone the page area already keeps room for the bottom bar and the launcher.
 */
export const PAGE_END_ROOM_CLASS =
  "md:data-[page-end-room=true]:after:block md:data-[page-end-room=true]:after:h-12";

/** The height PAGE_END_ROOM_CLASS adds after the page: `h-12`, 3rem. */
export const PAGE_END_ROOM_EXTRA_PX = 48;

/**
 * Whether a page area needs the room at its end: whether its page would still
 * scroll without it. Measured without the room so that adding it cannot change
 * the answer, which would switch it on and off for ever.
 */
export function pageNeedsEndRoom(
  pageArea: { scrollHeight: number; clientHeight: number },
  roomIsOn: boolean,
): boolean {
  const withoutRoom = roomIsOn ? pageArea.scrollHeight - PAGE_END_ROOM_EXTRA_PX : pageArea.scrollHeight;
  return withoutRoom > pageArea.clientHeight + 1;
}

/**
 * A row whose contents are allowed to move onto a second line. Pair it with
 * {@link OWN_LINE_ACTIONS_CLASS} on the part that should move.
 */
export const WRAPPING_ROW_CLASS = "flex flex-wrap items-start gap-x-3 gap-y-2";

/**
 * A group of buttons that takes a line of its own, and wraps on it, on
 * anything narrower than a laptop, then sits back on the original line at `lg`
 * and up.
 *
 * The five actions on an email sender card come to 481 pixels, and the card is
 * 333 pixels wide on a phone with `overflow-hidden`, so the last two were cut
 * off with no scrollbar and no wrap: a finger could never reach them.
 *
 * `basis-full` rather than a plain `w-full` because it is the flex base size
 * that decides which line an item lands on, and `lg:shrink-0` because the row
 * beside it has a zero base size, so without it every pixel of shrinking would
 * come out of these buttons rather than out of the text.
 */
export const OWN_LINE_ACTIONS_CLASS =
  "flex basis-full flex-wrap items-center gap-1.5 lg:basis-auto lg:flex-nowrap lg:shrink-0";

/**
 * Keeps the rows inside a scrolling column no wider than the column.
 *
 * The scrolling column comes from Radix, and Radix wraps whatever you put in
 * it in a box of its own that is set to `display: table` with a minimum width
 * of the column. A table box grows to fit its widest content, so a row set to
 * the full width of that box is the full width of the WIDEST row, not the
 * width of the column, and a row asking to cut its text short with three dots
 * never has to, because it was never short of room. Every mailbox and folder
 * row on the Email page ran 64 pixels past the right edge of the column that
 * clips it, at 375, 768 and 1280 alike, and the little refresh button in the
 * Folders heading sat entirely outside the column and could not be clicked.
 *
 * Turning that one box back into an ordinary block fixes all of it: a block is
 * exactly as wide as the space it is given and does not stretch for its
 * children. Nothing in this app scrolls a column sideways, which is the only
 * thing the table box buys.
 *
 * The `!` is needed because Radix sets `display` in a style attribute on the
 * element itself, and only an important rule can win against that.
 */
export const SCROLL_AREA_FITS_COLUMN_CLASS = "[&>div]:!block";

/**
 * A panel that fills the height it is given, and still has a readable height
 * when it is the page that scrolls rather than the panel.
 *
 * On a phone the app lets the whole page scroll, so nothing above a panel has
 * a settled height and `flex-1` resolves to nothing at all. A spinner, an
 * error or an empty-list message written that way is drawn 0 pixels tall and
 * simply never appears. The floor costs nothing on a desktop, where the panel
 * is taller than the floor anyway.
 */
export const FILLS_OR_KEEPS_HEIGHT_CLASS = "flex-1 min-h-40";

/**
 * How tall a message body is on a phone.
 *
 * Same reasoning as {@link FILLS_OR_KEEPS_HEIGHT_CLASS}, but a message body
 * needs a real reading height rather than a floor, and it is set in two places
 * that must agree: the frame that shows mail written as a web page, and the
 * scrolling box that shows mail written as plain text. If those two drifted
 * apart, the same message would be a different height depending on how the
 * sender wrote it.
 */
export const PHONE_MESSAGE_BODY_HEIGHT_CLASS = "h-[60dvh]";

/**
 * Pixels behind a Tailwind spacing class, for tests that check one clears the
 * other. Handles both a plain scale value (`h-16` is 4rem, so 64) and a rem
 * length inside an arbitrary value (`bottom-[calc(5rem+...)]` is 80). Returns
 * NaN for anything it cannot read.
 */
export function spacingClassPixels(className: string): number {
  const rem = /(\d+(?:\.\d+)?)rem/.exec(className);
  if (rem) return Number(rem[1]) * 16;
  const scale = /^[a-z-]+-(\d+(?:\.\d+)?)$/.exec(className);
  if (scale) return Number(scale[1]) * 4;
  return Number.NaN;
}
