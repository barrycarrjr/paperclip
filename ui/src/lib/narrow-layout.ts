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
