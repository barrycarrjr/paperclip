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
});
