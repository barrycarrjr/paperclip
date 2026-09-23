import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * How the Email page builds its message list. The page is too large to render
 * in a test, so these read its source.
 */

const source = readFileSync(fileURLToPath(new URL("./Email.tsx", import.meta.url)), "utf8");

function emailBody(): string {
  const start = source.indexOf("export function Email()");
  expect(start, "expected Email.tsx to declare export function Email()").toBeGreaterThan(-1);
  const end = source.slice(start).search(/\r?\n\}\r?\n/);
  expect(end, "expected the end of the Email function").toBeGreaterThan(0);
  return source.slice(start, start + end);
}

describe("the Email page's message list", () => {
  /**
   * A component declared inside another one is a new component every time the
   * outer one renders, so React throws away everything it drew and builds it
   * again. The message list and its row actions used to be declared that way,
   * and every update to the page rebuilt the list: it jumped back to the top,
   * a menu opened from a row further down appeared off screen, and an open
   * submenu closed by itself. They are plain functions now, called rather
   * than rendered.
   */
  it("is not built from components declared inside the page", () => {
    const inner =
      emailBody().match(
        /^[ \t]+(?:function\s+[A-Z]\w*\s*\(|const\s+[A-Z]\w*\s*=\s*(?:\(|function\b|memo\(|forwardRef\())/gm,
      ) ?? [];
    expect(inner.map((line) => line.trim())).toEqual([]);
  });

  /**
   * With the list no longer rebuilt on every render, its scroll box has to be
   * replaced on purpose when a different list is shown, or switching folder
   * opened the new list as far down as the old one had been scrolled. See
   * emailListKey for what counts as a different list.
   */
  it("keys each of its scroll boxes on the list it shows", () => {
    const body = emailBody();
    const start = body.indexOf("function renderSearchListBody(");
    const end = body.indexOf("const leftPaneDragHandle", start);
    expect(start, "expected renderSearchListBody in Email.tsx").toBeGreaterThan(-1);
    expect(end, "expected the list bodies to end before leftPaneDragHandle").toBeGreaterThan(start);
    // The search results, the plain list and the list grouped by sender.
    const scrollBoxes = body.slice(start, end).match(/<ScrollArea\b[^>]*>/g) ?? [];
    expect(scrollBoxes).toHaveLength(3);
    for (const box of scrollBoxes) expect(box).toContain("key={listScrollKey}");
  });

  /**
   * Opening a message from the full-width list replaces it with the narrow
   * list beside the message, and closing the message swaps them back. Either
   * list starts at the top when it appears, so the row of the message you
   * are on has to bring itself into view. See revealRowInList.
   */
  it("scrolls the open message's row into view, in the folder list and in search results", () => {
    const body = emailBody();
    for (const renderer of ["function renderRow(", "function renderSearchRow("]) {
      const start = body.indexOf(renderer);
      expect(start, `expected ${renderer} in Email.tsx`).toBeGreaterThan(-1);
      const end = body.indexOf("\n  }", start);
      expect(body.slice(start, end)).toMatch(
        /ref=\{[\s\S]*?\brevealRow\b[\s\S]*?\?\s*revealRowInList\s*:\s*undefined\s*\}/,
      );
    }
  });

  it("matches that row on its folder as well as its number", () => {
    // Every folder numbers its own messages, and search results mix folders,
    // so a number alone scrolled to a different message sharing it.
    const body = emailBody();
    const row = body.slice(body.indexOf("function renderRow("));
    expect(row.slice(0, row.indexOf("\n  }"))).toContain(
      "sameListRow(revealRow, { uid: msg.uid, mailbox: selectedMailbox, folder: selectedFolder })",
    );
    const hit = body.slice(body.indexOf("function renderSearchRow("));
    expect(hit.slice(0, hit.indexOf("\n  }"))).toContain("sameListRow(revealRow, hit)");
  });

  it("brings a closed message back into view once, not whenever its row reappears", () => {
    // A message archived from the reading pane is closed too; if the server
    // refused and the row came back later, the list jumped to it.
    const body = emailBody();
    expect(body).toContain("const revealRow = openRow ?? revealAfterClose;");
    expect(body).toMatch(
      /useEffect\(\(\) => \{\s*(?:\/\/[^\n]*\n\s*)*if \(revealAfterClose\) setRevealAfterClose\(null\);\s*\}, \[revealAfterClose\]\);/,
    );
  });
});
