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
 */
export const ABOVE_MOBILE_BOTTOM_NAV_CLASS =
  "bottom-[calc(5rem+env(safe-area-inset-bottom))] md:bottom-4";

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
