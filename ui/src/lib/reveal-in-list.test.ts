// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { followOpenRow, revealRowInList, sameListRow, scrollTopToReveal } from "./reveal-in-list";

// A list 400 pixels tall whose top edge is 100 pixels down the screen.
const view = { top: 100, height: 400 };

describe("scrollTopToReveal", () => {
  it("leaves a row that already shows in full where it is", () => {
    expect(scrollTopToReveal({ top: 150, height: 50 }, { ...view, scrollTop: 0 })).toBeNull();
    expect(scrollTopToReveal({ top: 450, height: 50 }, { ...view, scrollTop: 600 })).toBeNull();
  });

  it("brings a row from below the list into the middle of it", () => {
    // The fortieth row of 50 pixels sits 1950 pixels into the list.
    expect(scrollTopToReveal({ top: 100 + 1950, height: 50 }, { ...view, scrollTop: 0 })).toBe(1775);
  });

  it("brings a row from above the list into the middle of it", () => {
    expect(scrollTopToReveal({ top: 100 - 500, height: 50 }, { ...view, scrollTop: 1000 })).toBe(325);
  });

  // Centring a row you clicked at the edge moved the list half its height
  // and put a different message under the pointer. Only the hidden part
  // moves, so the same row stays under it.
  it("moves a row cut off at the bottom edge only as far as it needs", () => {
    expect(scrollTopToReveal({ top: 480, height: 50 }, { ...view, scrollTop: 0 })).toBe(30);
  });

  it("moves a row cut off at the top edge only as far as it needs", () => {
    expect(scrollTopToReveal({ top: 80, height: 50 }, { ...view, scrollTop: 300 })).toBe(280);
  });

  it("never scrolls above the top of the list", () => {
    // The first row, wholly above the view: centring it would be negative.
    expect(scrollTopToReveal({ top: -20, height: 50 }, { ...view, scrollTop: 120 })).toBe(0);
  });
});

describe("which message to bring back into view", () => {
  const forty = { uid: 40, mailbox: "sales", folder: "INBOX" };

  it("tells messages apart by folder as well as number", () => {
    // Every folder numbers its own messages, and search results mix folders.
    expect(sameListRow(forty, { ...forty })).toBe(true);
    expect(sameListRow(forty, { ...forty, folder: "Sent" })).toBe(false);
    expect(sameListRow(forty, { ...forty, mailbox: "support" })).toBe(false);
    expect(sameListRow(forty, null)).toBe(false);
    expect(sameListRow(null, null)).toBe(true);
  });

  it("remembers the open message, and hands it back once when it closes", () => {
    const whileOpen = followOpenRow(null, forty);
    expect(whileOpen).toEqual({ remembered: forty, justClosed: null });
    const closing = followOpenRow(whileOpen.remembered, null);
    expect(closing).toEqual({ remembered: null, justClosed: forty });
    // Only once: a row that comes back later, say after an archive the
    // server refused, must not pull the list to it.
    expect(followOpenRow(closing.remembered, null)).toEqual({ remembered: null, justClosed: null });
  });

  it("hands back the same value when nothing changed, so the page can store it without a loop", () => {
    const remembered = followOpenRow(null, forty).remembered;
    expect(followOpenRow(remembered, { ...forty }).remembered).toBe(remembered);
  });

  it("follows you to the next message you open", () => {
    const first = followOpenRow(null, forty).remembered;
    const twelve = { uid: 12, mailbox: "sales", folder: "Archive" };
    expect(followOpenRow(first, twelve)).toEqual({ remembered: twelve, justClosed: null });
  });
});

describe("revealRowInList", () => {
  beforeEach(() => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 0;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  // jsdom does no layout, so every size and scroll position is set by hand.
  function sized(element: HTMLElement, box: { top: number; height: number }, scrollHeight: number) {
    Object.defineProperty(element, "scrollTop", { value: 0, writable: true, configurable: true });
    Object.defineProperty(element, "clientHeight", { value: box.height, configurable: true });
    Object.defineProperty(element, "scrollHeight", { value: scrollHeight, configurable: true });
    element.getBoundingClientRect = () => box as DOMRect;
  }

  /** A row `rowTop` pixels down the screen, in a list like the Email page's. */
  function rowInList(rowTop: number, listScrollHeight = 3000) {
    const list = document.createElement("div");
    list.setAttribute("data-slot", "scroll-area-viewport");
    sized(list, view, listScrollHeight);
    const row = document.createElement("div");
    row.getBoundingClientRect = () => ({ top: rowTop, height: 50 }) as DOMRect;
    list.appendChild(row);
    document.body.appendChild(list);
    return { list, row };
  }

  it("scrolls the list so the open message's row shows", () => {
    const { list, row } = rowInList(100 + 1950);
    revealRowInList(row);
    expect(list.scrollTop).toBe(1775);
  });

  it("leaves the list alone when the row already shows", () => {
    const { list, row } = rowInList(200);
    revealRowInList(row);
    expect(list.scrollTop).toBe(0);
  });

  /** The page on a phone: 6000 pixels of document seen through an 800 pixel window. */
  function withPage(run: (page: HTMLElement) => void) {
    const page = document.createElement("html");
    Object.defineProperty(page, "scrollTop", { value: 0, writable: true, configurable: true });
    Object.defineProperty(page, "clientHeight", { value: 800, configurable: true });
    Object.defineProperty(page, "scrollHeight", { value: 6000, configurable: true });
    // The page's own box is the whole document, which is not what shows.
    page.getBoundingClientRect = () => ({ top: 0, height: 6000 }) as DOMRect;
    // jsdom has no scrollingElement, and a window height of its own.
    Object.defineProperty(document, "scrollingElement", { value: page, configurable: true });
    const windowHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    try {
      run(page);
    } finally {
      delete (document as unknown as { scrollingElement?: Element }).scrollingElement;
      Object.defineProperty(window, "innerHeight", { value: windowHeight, configurable: true });
    }
  }

  it("scrolls the page instead on a phone, where the list is as tall as its rows", () => {
    // The list shows everything, so it cannot scroll; the page does.
    const { list, row } = rowInList(2440, view.height);
    withPage((page) => {
      revealRowInList(row);
      expect(list.scrollTop).toBe(0);
      // Row top 2440 in an 800 pixel window: centred is 2440 - 375 = 2065.
      expect(page.scrollTop).toBe(2065);
    });
  });

  it("never moves a page the layout has pinned, as the desktop does", () => {
    // A short list with nothing to scroll falls through to the page, and on
    // a desktop the page must stay put or the whole app shifts.
    const { row } = rowInList(740, view.height);
    // The layout sets overflow hidden on the body; jsdom does not work out
    // the computed style from that, so it is given directly.
    const computed = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
      element === document.body ? ({ overflowY: "hidden" } as CSSStyleDeclaration) : computed(element),
    );
    withPage((page) => {
      revealRowInList(row);
      expect(page.scrollTop).toBe(0);
    });
  });

  it("centres the row on a phone even when it is on screen, since the bars cover the edges", () => {
    // 740 to 790 of an 800 pixel window is behind the bottom menu.
    const { row } = rowInList(740, view.height);
    withPage((page) => {
      revealRowInList(row);
      expect(page.scrollTop).toBe(365);
    });
  });

  it("does nothing when the row has gone, or nothing can scroll", () => {
    expect(() => revealRowInList(null)).not.toThrow();
    const loose = document.createElement("div");
    document.body.appendChild(loose);
    expect(() => revealRowInList(loose)).not.toThrow();
    const { list, row } = rowInList(100 + 1950);
    row.remove();
    revealRowInList(row);
    expect(list.scrollTop).toBe(0);
  });
});
