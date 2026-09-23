import { describe, expect, it } from "vitest";
import {
  clampListPaneWidth,
  dragListPaneWidth,
  emailListKey,
  emailPaneLayout,
  LIST_PANE_DEFAULT_WIDTH,
  LIST_PANE_MAX_WIDTH,
  LIST_PANE_MIN_WIDTH,
  listPaneMaxWidthCss,
  listPaneMaxWidthPx,
} from "./email-pane-layout";

describe("the message list's width beside an open message", () => {
  it("starts where the old fixed column was", () => {
    expect(LIST_PANE_DEFAULT_WIDTH).toBe(288);
  });

  it("keeps a dragged width within bounds", () => {
    expect(clampListPaneWidth(400)).toBe(400);
    expect(clampListPaneWidth(10)).toBe(LIST_PANE_MIN_WIDTH);
    expect(clampListPaneWidth(5000)).toBe(LIST_PANE_MAX_WIDTH);
    expect(clampListPaneWidth(333.6)).toBe(334);
  });

  it("recovers from a stored width that is not a number", () => {
    // Read back from localStorage, so it arrives as a string or as junk.
    expect(clampListPaneWidth("420")).toBe(420);
    expect(clampListPaneWidth("wide")).toBe(LIST_PANE_DEFAULT_WIDTH);
    expect(clampListPaneWidth(null)).toBe(LIST_PANE_DEFAULT_WIDTH);
    expect(clampListPaneWidth(Number.NaN)).toBe(LIST_PANE_DEFAULT_WIDTH);
  });

  it("leaves the message at least half of what the mailbox column leaves", () => {
    expect(listPaneMaxWidthPx(1100, 176)).toBe(462);
    // The case half the whole page got wrong: a 400 pixel mailbox column on
    // an 800 pixel page left the message nothing.
    expect(listPaneMaxWidthPx(800, 400)).toBe(200);
    expect(listPaneMaxWidthCss(400)).toBe("calc((100% - 400px) / 2)");
  });

  it("treats a mailbox width that is not a real width as no column", () => {
    // Read back from localStorage, so junk is possible.
    expect(listPaneMaxWidthCss(Number.NaN)).toBe("calc((100% - 0px) / 2)");
    expect(listPaneMaxWidthPx(800, Number.NaN)).toBe(400);
    expect(listPaneMaxWidthPx(300, 400)).toBe(0);
  });

  it("drags from the width on screen, so the edge stays under the pointer", () => {
    // Stored 640 but held to 550 by the cap: one pixel left is 549, not the
    // 90 pixel dead zone that starting from 640 gave.
    expect(dragListPaneWidth(550, -1, 550)).toBe(549);
    expect(dragListPaneWidth(300, 50, 900)).toBe(350);
  });

  it("stops a drag at the cap and at the bounds", () => {
    expect(dragListPaneWidth(500, 200, 550)).toBe(550);
    expect(dragListPaneWidth(500, 500, 2000)).toBe(LIST_PANE_MAX_WIDTH);
    expect(dragListPaneWidth(300, -200, 550)).toBe(LIST_PANE_MIN_WIDTH);
    // Too narrow a screen for the minimum: the cap wins, so the list cannot
    // be dragged over the message.
    expect(dragListPaneWidth(200, 100, 200)).toBe(200);
    expect(dragListPaneWidth(300, 10.4, Number.NaN)).toBe(310);
  });
});

describe("which list the page is showing", () => {
  const inbox = {
    companyId: "company-a",
    mailbox: "sales",
    folder: "INBOX",
    view: "all",
    groupBySender: false,
    search: "",
  };

  it("stays the same while the list updates in place, so its scroll is kept", () => {
    expect(emailListKey({ ...inbox })).toBe(emailListKey(inbox));
  });

  it("changes with anything that shows a different list, so that list starts at the top", () => {
    const others = [
      { ...inbox, companyId: "company-b" },
      { ...inbox, mailbox: "support" },
      { ...inbox, folder: "Archive" },
      { ...inbox, view: "unread" },
      { ...inbox, groupBySender: true },
      { ...inbox, search: "invoice" },
    ];
    for (const other of others) expect(emailListKey(other)).not.toBe(emailListKey(inbox));
  });

  it("keeps a search's place while its results are opened from other folders", () => {
    // Opening a result switches to that result's mailbox and folder. The
    // results themselves do not change, so neither may their scroll.
    const searching = { ...inbox, search: "invoice" };
    const afterOpeningAResult = {
      ...searching,
      mailbox: "support",
      folder: "Sent",
      view: "unread",
      groupBySender: true,
    };
    expect(emailListKey(afterOpeningAResult)).toBe(emailListKey(searching));
    expect(emailListKey({ ...searching, search: "quote" })).not.toBe(emailListKey(searching));
    expect(emailListKey({ ...searching, companyId: "company-b" })).not.toBe(emailListKey(searching));
  });
});

const cases = [
  { isMobile: false, messageOpen: false },
  { isMobile: false, messageOpen: true },
  { isMobile: true, messageOpen: false },
  { isMobile: true, messageOpen: true },
];

describe("which parts of the Email page are on screen", () => {
  it("shows all three side by side on a desktop", () => {
    expect(emailPaneLayout({ isMobile: false, messageOpen: true })).toEqual({
      mailboxColumn: true,
      mailboxDrawer: false,
      columnDragHandle: true,
      messageList: true,
      openMessage: true,
      backToListButton: false,
    });
  });

  it("shows the list on a phone until a message is opened", () => {
    expect(emailPaneLayout({ isMobile: true, messageOpen: false })).toMatchObject({
      messageList: true,
      openMessage: false,
    });
    expect(emailPaneLayout({ isMobile: true, messageOpen: true })).toMatchObject({
      messageList: false,
      openMessage: true,
    });
  });

  // The audit found the desktop layout squeezed into 335 pixels: a 176 pixel
  // mailbox column, 155 pixels of list, no reading pane, and the list's own
  // tabs painted on top of the folder list beside them. One at a time is the
  // rule that replaces it.
  it("never puts the list and an open message side by side on a phone", () => {
    for (const messageOpen of [false, true]) {
      const panes = emailPaneLayout({ isMobile: true, messageOpen });
      expect(panes.messageList && panes.openMessage).toBe(false);
    }
  });

  it("always leaves a way to the mailbox and folder tree", () => {
    for (const input of cases) {
      const panes = emailPaneLayout(input);
      expect(panes.mailboxColumn || panes.mailboxDrawer).toBe(true);
    }
  });

  it("never shows the tree in both places at once", () => {
    for (const input of cases) {
      const panes = emailPaneLayout(input);
      expect(panes.mailboxColumn && panes.mailboxDrawer).toBe(false);
    }
  });

  // Hiding the list is only safe if something else offers a way back to it.
  // The two halves sit hundreds of lines apart in the page, so this is the
  // check that they still agree.
  it("offers a way back whenever the list is hidden behind an open message", () => {
    for (const input of cases) {
      const panes = emailPaneLayout(input);
      if (panes.openMessage && !panes.messageList) {
        expect(panes.backToListButton).toBe(true);
      }
    }
  });

  it("does not offer a way back while the list is still on screen", () => {
    for (const input of cases) {
      const panes = emailPaneLayout(input);
      if (panes.messageList) expect(panes.backToListButton).toBe(false);
    }
  });

  // The handle drags the mailbox column wider. With the column in a drawer
  // there is nothing for it to drag, and a 4 pixel strip is not something a
  // finger can grab anyway.
  it("only offers the column drag handle where the column itself is", () => {
    for (const input of cases) {
      const panes = emailPaneLayout(input);
      if (panes.columnDragHandle) expect(panes.mailboxColumn).toBe(true);
    }
  });
});
