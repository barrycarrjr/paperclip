/**
 * Which parts of the Email page are on screen at once.
 *
 * The page has three of them: the mailbox and folder tree, the list of
 * messages, and the message you have open. A desktop window is wide enough to
 * show all three side by side. A phone is not, and squeezing them in anyway is
 * what the narrow-width audit on 2026-09-08 found: the mailbox column took 176
 * of 335 pixels, the list got the rest, there was no reading pane at all, and
 * the three list tabs were painted on top of the folder list next to them.
 *
 * So on a phone the page shows one at a time. The tree moves into a drawer
 * that slides over the list, and opening a message replaces the list until you
 * come back. Nothing is dropped; only where it sits changes.
 *
 * This lives on its own, away from the page, because the halves have to agree
 * and they are far apart in a three thousand line file: hiding the list is only
 * safe if something else offers a way back to it, and a handle for dragging the
 * mailbox column wider is meaningless when that column is not on screen.
 */

import { followPointerDrag } from "./pointer-drag";

/**
 * The message list's width, in pixels, while a message is open beside it. It
 * used to be a fixed 288 (Tailwind's w-72) with no way to widen it, too narrow
 * for a sender and subject once anything shared the row. Now it drags wider
 * or narrower like the mailbox column does, within these bounds, and a stored
 * width that has gone out of bounds (or is not a number) comes back inside
 * them rather than breaking the layout.
 */
export const LIST_PANE_DEFAULT_WIDTH = 288;
export const LIST_PANE_MIN_WIDTH = 240;
export const LIST_PANE_MAX_WIDTH = 640;

export function clampListPaneWidth(value: unknown): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return LIST_PANE_DEFAULT_WIDTH;
  return Math.min(LIST_PANE_MAX_WIDTH, Math.max(LIST_PANE_MIN_WIDTH, Math.round(n)));
}

/**
 * The widest the list may be beside an open message: half of what the mailbox
 * column leaves, so the message always keeps the other half. Half of the whole
 * page, the first version of this, ignored the mailbox column: with that
 * column at its widest on a narrow screen, the message shrank to nothing and
 * pushed the list's own drag handle out of view.
 *
 * The page sets it as a CSS max-width, so it holds as the window changes size,
 * and a drag stops at the same place in pixels. Both come from here so that
 * they agree.
 */
export function listPaneMaxWidthCss(mailboxColumnWidth: number): string {
  return `calc((100% - ${widthOrZero(mailboxColumnWidth)}px) / 2)`;
}

export function listPaneMaxWidthPx(pageWidth: number, mailboxColumnWidth: number): number {
  return Math.max(0, Math.floor((widthOrZero(pageWidth) - widthOrZero(mailboxColumnWidth)) / 2));
}

/**
 * The list's width part way through a drag. It starts from the width on
 * screen, not the stored one, because the cap above can hold the list
 * narrower than what was stored: starting from the stored width left the edge
 * still for the difference and then trailing the pointer by it. It stops at
 * the cap too, so the width stored at the end is the one that was on screen.
 */
export function dragListPaneWidth(startWidth: number, deltaX: number, maxShown: number): number {
  const upper = Number.isFinite(maxShown) ? Math.min(LIST_PANE_MAX_WIDTH, maxShown) : LIST_PANE_MAX_WIDTH;
  // On a screen too narrow for the usual minimum, the cap wins.
  const lower = Math.min(LIST_PANE_MIN_WIDTH, upper);
  return Math.round(Math.min(upper, Math.max(lower, startWidth + deltaX)));
}

/** How far the pointer has to move before a press on the handle is a drag. */
const LIST_PANE_DRAG_THRESHOLD = 3;

/**
 * Resizes the list from a press on its drag handle, measuring the list and
 * the page it sits in at the moment of the press. `onResize` gets each new
 * width as the pointer moves, and `onDone` the last one when it is let go.
 *
 * A click is not a drag, nor are the two behind a double-click: until the
 * pointer has moved a few pixels sideways nothing changes and nothing is
 * saved. Without that, a wobble of the hand during a click saved whatever the
 * cap was showing over the width chosen on a wider screen.
 */
export function startListPaneResize(
  list: HTMLElement,
  handle: HTMLElement,
  press: { pointerId: number; clientX: number },
  mailboxColumnWidth: number,
  { onResize, onDone }: { onResize: (width: number) => void; onDone: (width: number) => void },
): void {
  const page = list.parentElement;
  if (!page) return;
  const startWidth = list.getBoundingClientRect().width;
  const maxShown = listPaneMaxWidthPx(page.clientWidth, mailboxColumnWidth);
  let moved = false;
  let lastWidth = startWidth;
  followPointerDrag(handle, press, {
    onMove: (deltaX) => {
      if (!moved && Math.abs(deltaX) < LIST_PANE_DRAG_THRESHOLD) return;
      moved = true;
      lastWidth = dragListPaneWidth(startWidth, deltaX, maxShown);
      onResize(lastWidth);
    },
    onEnd: () => {
      if (moved) onDone(lastWidth);
    },
  });
}

/**
 * Names the list the page is showing, for the list's scroll box to use as its
 * key. The list keeps its scroll position while it updates in place (new mail
 * arriving, another message opened beside it) and starts again at the top
 * when this changes: another company, mailbox, folder, tab, grouping or
 * search. While the page rebuilt the list on every render, the scroll went
 * back to the top all the time and hid that nothing did it on purpose;
 * without this, switching folder opened the new list as far down as the old
 * one had been scrolled.
 *
 * Search results come from every mailbox and folder, and opening one switches
 * to that result's mailbox and folder, so while a search is showing only the
 * search names the list. Keyed on the folder too, the results jumped back to
 * the top whenever a result from another folder was opened.
 */
export function emailListKey(list: {
  companyId: string | null | undefined;
  mailbox: string | null;
  folder: string;
  view: string;
  groupBySender: boolean;
  search: string;
}): string {
  if (list.search) return JSON.stringify([list.companyId ?? "", "search", list.search]);
  return JSON.stringify([
    list.companyId ?? "",
    list.mailbox ?? "",
    list.folder,
    list.view,
    list.groupBySender,
  ]);
}

function widthOrZero(width: number): number {
  return Number.isFinite(width) && width > 0 ? width : 0;
}

export interface EmailPaneLayout {
  /** The mailbox and folder tree, as a column beside the list. */
  mailboxColumn: boolean;
  /** The same tree, as a drawer that slides over the list. */
  mailboxDrawer: boolean;
  /** The thin strip that drags the mailbox column wider or narrower. */
  columnDragHandle: boolean;
  /** The list of messages. */
  messageList: boolean;
  /** The message you have open. */
  openMessage: boolean;
  /** A way back to the list from an open message, for when the list is gone. */
  backToListButton: boolean;
}

export function emailPaneLayout({
  isMobile,
  messageOpen,
}: {
  isMobile: boolean;
  messageOpen: boolean;
}): EmailPaneLayout {
  if (!isMobile) {
    return {
      mailboxColumn: true,
      mailboxDrawer: false,
      columnDragHandle: true,
      messageList: true,
      openMessage: messageOpen,
      backToListButton: false,
    };
  }

  return {
    mailboxColumn: false,
    mailboxDrawer: true,
    columnDragHandle: false,
    messageList: !messageOpen,
    openMessage: messageOpen,
    backToListButton: messageOpen,
  };
}
