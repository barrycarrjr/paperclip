/**
 * Room for a page's own bar pinned along the bottom of the window.
 *
 * A page can pin a bar to the bottom: the Save and Cancel bar on an agent's
 * Instructions and Configuration tabs, the action bar that comes up when rows
 * are selected, a save bar that sticks to the bottom, the reply box that
 * sticks to the foot of an issue. The app keeps floating controls along the
 * same edge: the Clippy launcher and the page's scroll buttons in the bottom
 * right corner, and the toasts in the bottom left. Each was placed without
 * knowing about the other, so the launcher sat on the agent Save bar.
 *
 * The rule: a page's bottom bar registers here (usePageBottomBarRef), and
 * while it is pinned along the bottom of the window the document carries
 * `--page-bottom-bar-room`, how far up from the bottom of the window the bar
 * reaches. The launcher, the scroll buttons and the toasts add it to their own
 * bottom offset (lib/narrow-layout), so they sit above the bar instead of on
 * it, and drop back down when it goes.
 *
 * Only a bar pinned to the bottom counts, so a sticky bar lifts the launcher
 * while it is stuck and lets it back down once the page has scrolled to the
 * bar's own place. The end of a page that scrolls is a separate half of the
 * same rule: the page area keeps room under its last row for the launcher
 * (PAGE_END_ROOM_CLASS), which is what keeps the Submit button that ends the
 * Pipelines "add items" page clear of it.
 *
 * On a phone a page's bar rests on top of the app's own bottom bar
 * (PAGE_BOTTOM_BAR_FLUSH_CLASS and PAGE_BOTTOM_BAR_FLOATING_CLASS), so the
 * bars are counted as a stack from the bottom up: a bar whose lower edge is
 * close to the top of the bottom bar, or of a bar already counted, counts as
 * well. Measured against the window alone, the agent Save bar resting on the
 * bottom bar was 65 pixels up, past the reach below, and did not count, so the
 * launcher sat on its Save button. The bottom bar tells this file whether it
 * shows (setPhoneBottomBar), and its share of the room comes from that rather
 * than from measuring it: it slides away and back as the page scrolls, and
 * measured on every frame of the slide the room was written again each time,
 * a full restyle of the page for each frame.
 *
 * A bar fixed over the page also needs room at the end of the page, or the
 * last rows are under it however far the page is scrolled: two rows of
 * selection buttons hid the end of the portfolio issues list on a phone.
 * `--page-bottom-bar-end-room` says how far up those bars reach, and the page
 * area keeps that much more room at its end on a phone (lib/narrow-layout,
 * PHONE_PAGE_END_ROOM_CLASS). While the same bars are up it only ever grows:
 * they sit lower while the bottom bar is away, and shrinking the end of the
 * page each time that bar slid would move a page scrolled to its end. A sticky
 * bar is left out, since it takes its own place at the end.
 */

/** The custom property the room is written to, on the document element. */
export const PAGE_BOTTOM_BAR_ROOM_PROPERTY = "--page-bottom-bar-room";

/** The custom property the room for the end of the page is written to, on the document element. */
export const PAGE_BOTTOM_BAR_END_ROOM_PROPERTY = "--page-bottom-bar-end-room";

/**
 * How close to where bars rest a bar's lower edge has to be to count as pinned
 * there: the bottom of the window, above the safe area, or the top of the
 * phone bottom bar or of a bar already counted. 4rem, just above the top of
 * the launcher in its corner (1rem up and 2.5rem tall). A fixed bar sits 24
 * pixels up and a sticky one 20 pixels or less; a row that has scrolled to its
 * own place at the end of a page sits higher than this, above the room the
 * page area keeps.
 */
export const PAGE_BOTTOM_BAR_REACH_PX = 64;

/** The part of a bar's on-screen box that matters here, in window pixels. */
export interface PageBottomBarBox {
  top: number;
  bottom: number;
}

/** The phone bottom bar: its own height, the safe area under it included, and whether it shows. */
export interface PhoneBottomBarState {
  height: number;
  shown: boolean;
}

/** What else the room depends on besides the bars: the phone bottom bar, and the bottom safe area in pixels. */
export interface PageBottomBarSurroundings {
  phoneBottomBar?: PhoneBottomBarState | null;
  safeArea?: number;
}

/**
 * How many pixels up from the bottom of the window the bars along it reach: 0
 * when no bar is there. The phone bottom bar counts for its height while it
 * shows, whatever point of its slide it is at. A page's bar that is not drawn
 * (no height) does not count, nor does one whose lower edge is more than
 * PAGE_BOTTOM_BAR_REACH_PX above where bars rest: the top of the phone bottom
 * bar (shown, or on its way back, since a bar resting on it slides with it),
 * the top of the safe area, or the top of a bar counted below it. Never more
 * than half the window, so a tall bar cannot push the launcher off the top of
 * a short window.
 */
export function pageBottomBarRoom(
  bars: readonly PageBottomBarBox[],
  viewportHeight: number,
  { phoneBottomBar = null, safeArea = 0 }: PageBottomBarSurroundings = {},
): number {
  const phoneHeight = phoneBottomBar?.height ?? 0;
  // With a tall safe area, as Android reports behind a three-button bar, a
  // bar floating 24 pixels above it was further up than the reach from the
  // very bottom, and the launcher landed on it.
  let restsAt = viewportHeight - Math.max(phoneHeight, safeArea);
  let top = viewportHeight - (phoneBottomBar?.shown ? phoneHeight : 0);
  // From the lowest bar up, so each one is held against the stack below it.
  const drawn = bars.filter((bar) => bar.bottom > bar.top).sort((a, b) => b.bottom - a.bottom);
  for (const bar of drawn) {
    if (restsAt - bar.bottom > PAGE_BOTTOM_BAR_REACH_PX) break;
    top = Math.min(top, bar.top);
    restsAt = Math.min(restsAt, bar.top);
  }
  return Math.round(Math.min(Math.max(viewportHeight - top, 0), viewportHeight / 2));
}

const registeredBars = new Set<HTMLElement>();
let phoneBottomBar: { element: HTMLElement; shown: boolean } | null = null;
let frame = 0;
let resizeObserver: ResizeObserver | null = null;
let safeAreaProbe: HTMLElement | null = null;
const written = new Map<string, number>();
let endRoom = 0;
let endRoomBars: HTMLElement[] = [];

function write(property: string, px: number) {
  if (typeof document === "undefined" || (written.get(property) ?? 0) === px) return;
  written.set(property, px);
  const root = document.documentElement;
  if (px > 0) root.style.setProperty(property, `${px}px`);
  else root.style.removeProperty(property);
}

/** The bottom safe area in pixels, read off an element that is never seen. */
function safeAreaInsetBottom(): number {
  if (!safeAreaProbe?.isConnected) {
    safeAreaProbe = document.createElement("div");
    safeAreaProbe.setAttribute("aria-hidden", "true");
    safeAreaProbe.style.cssText =
      "position:fixed;left:0;bottom:0;width:0;height:env(safe-area-inset-bottom);visibility:hidden;pointer-events:none";
    document.body.appendChild(safeAreaProbe);
  }
  return safeAreaProbe.offsetHeight;
}

function phoneBottomBarState(): PhoneBottomBarState | null {
  if (!phoneBottomBar || !phoneBottomBar.element.isConnected) return null;
  // The bar's own height, which its slide does not change: it slides by a
  // transform.
  return { height: phoneBottomBar.element.offsetHeight, shown: phoneBottomBar.shown };
}

function measure() {
  frame = 0;
  if (registeredBars.size === 0 && !phoneBottomBar) {
    write(PAGE_BOTTOM_BAR_ROOM_PROPERTY, 0);
    write(PAGE_BOTTOM_BAR_END_ROOM_PROPERTY, 0);
    endRoom = 0;
    endRoomBars = [];
    safeAreaProbe?.remove();
    safeAreaProbe = null;
    return;
  }
  const bars = [...registeredBars].filter((bar) => bar.isConnected);
  const boxes = bars.map((bar) => bar.getBoundingClientRect());
  const phone = phoneBottomBarState();
  const surroundings = { phoneBottomBar: phone, safeArea: safeAreaInsetBottom() };
  const viewportHeight = window.innerHeight;
  write(PAGE_BOTTOM_BAR_ROOM_PROPERTY, pageBottomBarRoom(boxes, viewportHeight, surroundings));

  // The end of the page only has to clear the bars fixed over it.
  const fixedBars = bars.filter((bar) => getComputedStyle(bar).position === "fixed");
  const counted = pageBottomBarRoom(
    fixedBars.map((bar) => boxes[bars.indexOf(bar)]!),
    viewportHeight,
    surroundings,
  );
  // Nothing when no fixed bar counted: the room is then the bottom bar's own,
  // which the page area keeps already.
  const current = counted > Math.round(phone?.shown ? phone.height : 0) ? counted : 0;
  // Never less while the same bars are up (see the top of this file).
  const sameBars = fixedBars.length === endRoomBars.length && fixedBars.every((bar, index) => bar === endRoomBars[index]);
  endRoom = sameBars ? Math.max(endRoom, current) : current;
  endRoomBars = fixedBars;
  write(PAGE_BOTTOM_BAR_END_ROOM_PROPERTY, endRoom);
}

function scheduleMeasure() {
  if (frame !== 0) return;
  frame = window.requestAnimationFrame(measure);
}

function observe(bar: HTMLElement) {
  if (!resizeObserver) return;
  resizeObserver.observe(bar);
  // A sticky bar moves when the content above it grows or shrinks, without
  // its own size changing and without any scrolling. Its parent does change
  // size then, so watch that too.
  if (bar.parentElement) resizeObserver.observe(bar.parentElement);
}

function start() {
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(scheduleMeasure);
  }
  // Capture, so the page area's own scrolling is seen as well as the window's.
  document.addEventListener("scroll", scheduleMeasure, { capture: true, passive: true });
  window.addEventListener("resize", scheduleMeasure);
}

function stop() {
  resizeObserver?.disconnect();
  resizeObserver = null;
  document.removeEventListener("scroll", scheduleMeasure, { capture: true });
  window.removeEventListener("resize", scheduleMeasure);
  // Gives the room back, or leaves the phone bottom bar's own.
  scheduleMeasure();
}

/**
 * Says where the phone bottom bar is and whether it shows (MobileBottomNav,
 * through usePhoneBottomBar). Only a change of either measures again: the
 * bar's share of the room comes from whether it shows, so nothing is measured
 * or written while it slides. Returns the function that forgets it.
 */
export function setPhoneBottomBar(element: HTMLElement, shown: boolean): () => void {
  if (typeof window === "undefined") return () => {};
  phoneBottomBar = { element, shown };
  // Turning the phone changes the safe area under the bar, and so its height.
  window.addEventListener("resize", measureAfterResize);
  scheduleMeasure();
  return () => {
    if (phoneBottomBar?.element !== element) return;
    phoneBottomBar = null;
    window.removeEventListener("resize", measureAfterResize);
    scheduleMeasure();
  };
}

function measureAfterResize() {
  scheduleMeasure();
}

/**
 * Starts keeping the room up to date for one bar. Returns the function that
 * stops it, which also gives the room back once the last bar has gone.
 */
export function registerPageBottomBar(bar: HTMLElement): () => void {
  if (typeof window === "undefined") return () => {};
  if (registeredBars.size === 0) start();
  registeredBars.add(bar);
  observe(bar);
  // The phone bottom bar slides away and back as the page scrolls, and a
  // page's bar resting on it slides with it. The slide goes on after the
  // scroll that started it has been measured, so measure again once a bar
  // has come to rest.
  bar.addEventListener("transitionend", scheduleMeasure);
  measure();
  return () => {
    if (!registeredBars.delete(bar)) return;
    bar.removeEventListener("transitionend", scheduleMeasure);
    if (registeredBars.size === 0) {
      stop();
      return;
    }
    // Watch only what the bars still there need.
    resizeObserver?.disconnect();
    for (const remaining of registeredBars) observe(remaining);
    scheduleMeasure();
  };
}
