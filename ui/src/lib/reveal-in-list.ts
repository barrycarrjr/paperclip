/**
 * Keeping your place in the Email page's list when it changes shape.
 *
 * Opening a message from the full-width list swaps that list for the narrow
 * one beside the message, and the narrow one is new, so it started at the
 * top: open the fortieth message and the list showed the first dozen or so,
 * with the one you opened out of sight below them. Closing the message swaps
 * them back, and the full-width list started at the top the same way.
 */

/**
 * Where to scroll a list so a row shows: null if it already shows in full.
 * A row cut off at an edge moves only as far as it needs to. Centring it
 * instead moved the list half its height when you clicked a row at the
 * bottom edge, and put a different message under the pointer. A row wholly
 * out of sight goes to the middle, so the messages either side of it show
 * too. `top` values are on-screen positions, as getBoundingClientRect gives
 * them.
 */
export function scrollTopToReveal(
  row: { top: number; height: number },
  view: { top: number; height: number; scrollTop: number },
): number | null {
  const rowBottom = row.top + row.height;
  const viewBottom = view.top + view.height;
  if (row.top >= view.top && rowBottom <= viewBottom) return null;
  const rowOffset = row.top - view.top + view.scrollTop;
  const partlyShows = rowBottom > view.top && row.top < viewBottom;
  if (!partlyShows) return scrollTopToCentre(row, view);
  const target = row.top < view.top ? rowOffset : rowOffset + row.height - view.height;
  return Math.max(0, Math.round(target));
}

/** Where to scroll so a row sits in the middle of the view. */
export function scrollTopToCentre(
  row: { top: number; height: number },
  view: { top: number; height: number; scrollTop: number },
): number {
  const rowOffset = row.top - view.top + view.scrollTop;
  return Math.max(0, Math.round(rowOffset - (view.height - row.height) / 2));
}

/**
 * One message in one folder. A uid alone is not enough: every folder numbers
 * its own messages, and search results mix folders, so two results can share
 * a uid.
 */
export interface ListRow {
  uid: number;
  mailbox: string | null;
  folder: string;
}

export function sameListRow(a: ListRow | null, b: ListRow | null): boolean {
  if (!a || !b) return a === b;
  return a.uid === b.uid && a.mailbox === b.mailbox && a.folder === b.folder;
}

/**
 * Follows the open message from one render to the next. While a message is
 * open it is remembered; on the render after it closes it comes back once, as
 * `justClosed`, so the full-width list can bring it back into view. Only once:
 * a message archived or deleted from the reading pane is closed too, and if
 * the server then refuses and the row comes back later, the list must not
 * jump to it. `remembered` comes back unchanged when nothing changed, so the
 * page can keep it as state without an update loop.
 */
export function followOpenRow(
  remembered: ListRow | null,
  open: ListRow | null,
): { remembered: ListRow | null; justClosed: ListRow | null } {
  if (open) return { remembered: sameListRow(remembered, open) ? remembered : open, justClosed: null };
  return { remembered: null, justClosed: remembered };
}

/**
 * The scroll box that moves a row: the list's own on a desktop, or the page
 * on a phone, where the list is as tall as its rows and the page scrolls.
 * Null when neither has anything out of sight. The desktop layout pins the
 * page (overflow hidden) and scrolls each column instead, and a pinned page
 * is never moved: a script can still scroll it, which would shift the whole
 * app out of place.
 */
function scrollBoxOf(row: HTMLElement): HTMLElement | null {
  const list = row.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
  if (list && list.scrollHeight > list.clientHeight) return list;
  const page = document.scrollingElement;
  if (!(page instanceof HTMLElement) || page.scrollHeight <= page.clientHeight) return null;
  const pinned = (element: Element) => getComputedStyle(element).overflowY === "hidden";
  return pinned(document.documentElement) || pinned(document.body) ? null : page;
}

/**
 * Scrolls a row into view. Meant as the ref of the row of the message you are
 * on, so it runs when that row first appears (either list arriving after a
 * message is opened or closed) and when another row becomes the open one,
 * but not on every render: a scroll you make afterwards is left alone.
 *
 * When the page is what scrolls (a phone), the row goes to the middle of the
 * window every time. The window's top and bottom edges sit under the app's top
 * bar and bottom menu, so a row there counted as showing while it was hidden.
 *
 * Waits a frame, so the list has its size before it is measured.
 */
export function revealRowInList(row: HTMLElement | null): void {
  if (!row) return;
  requestAnimationFrame(() => {
    if (!row.isConnected) return;
    const box = scrollBoxOf(row);
    if (!box) return;
    const rowBox = row.getBoundingClientRect();
    const rowPlace = { top: rowBox.top, height: rowBox.height };
    let next: number | null;
    if (box === document.scrollingElement) {
      // The page's own box is the whole document; what shows is the window.
      next = scrollTopToCentre(rowPlace, { top: 0, height: window.innerHeight, scrollTop: box.scrollTop });
    } else {
      const viewBox = box.getBoundingClientRect();
      next = scrollTopToReveal(rowPlace, { top: viewBox.top, height: viewBox.height, scrollTop: box.scrollTop });
    }
    if (next !== null) box.scrollTop = next;
  });
}
