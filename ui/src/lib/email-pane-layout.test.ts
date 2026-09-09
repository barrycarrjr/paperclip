import { describe, expect, it } from "vitest";
import { emailPaneLayout } from "./email-pane-layout";

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
