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
 */

/** The custom property the room is written to, on the document element. */
export const PAGE_BOTTOM_BAR_ROOM_PROPERTY = "--page-bottom-bar-room";

/**
 * How close to the bottom of the window a bar's lower edge has to be to count
 * as pinned there: 4rem, just above the top of the launcher in its corner
 * (1rem up and 2.5rem tall). A fixed bar sits 24 pixels up and a sticky one
 * 20 pixels or less; a row that has scrolled to its own place at the end of
 * a page sits higher than this, above the room the page area keeps.
 */
export const PAGE_BOTTOM_BAR_REACH_PX = 64;

/** The part of a bar's on-screen box that matters here, in window pixels. */
export interface PageBottomBarBox {
  top: number;
  bottom: number;
}

/**
 * How many pixels up from the bottom of the window the highest bar along it
 * reaches: 0 when no bar is there. A bar that is not drawn (no height) does
 * not count, nor does one whose lower edge is higher up the window than
 * PAGE_BOTTOM_BAR_REACH_PX. Never more than half the window, so a tall bar
 * cannot push the launcher off the top of a short window.
 */
export function pageBottomBarRoom(bars: readonly PageBottomBarBox[], viewportHeight: number): number {
  let room = 0;
  for (const bar of bars) {
    if (!(bar.bottom > bar.top)) continue;
    if (viewportHeight - bar.bottom > PAGE_BOTTOM_BAR_REACH_PX) continue;
    room = Math.max(room, viewportHeight - bar.top);
  }
  return Math.round(Math.min(Math.max(room, 0), viewportHeight / 2));
}

const registeredBars = new Set<HTMLElement>();
let frame = 0;
let resizeObserver: ResizeObserver | null = null;
let writtenRoom = 0;

function writeRoom(room: number) {
  if (typeof document === "undefined" || room === writtenRoom) return;
  writtenRoom = room;
  const root = document.documentElement;
  if (room > 0) root.style.setProperty(PAGE_BOTTOM_BAR_ROOM_PROPERTY, `${room}px`);
  else root.style.removeProperty(PAGE_BOTTOM_BAR_ROOM_PROPERTY);
}

function measure() {
  frame = 0;
  const boxes = [...registeredBars]
    .filter((bar) => bar.isConnected)
    .map((bar) => bar.getBoundingClientRect());
  writeRoom(pageBottomBarRoom(boxes, window.innerHeight));
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
  if (frame !== 0) window.cancelAnimationFrame(frame);
  frame = 0;
  writeRoom(0);
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
  measure();
  return () => {
    if (!registeredBars.delete(bar)) return;
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
