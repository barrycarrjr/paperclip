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
