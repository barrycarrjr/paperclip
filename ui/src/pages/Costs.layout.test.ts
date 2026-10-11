import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The Costs page's rows of two unequal cards, such as the Inference ledger
 * beside the Finance ledger. A grid stretches every card in a row to the
 * tallest one, and at 1280 pixels the Inference ledger was drawn as a tall
 * empty box beside the Finance ledger's four figures. items-start keeps each
 * card its own height. jsdom draws nothing, so this reads the page's classes.
 */
const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "Costs.tsx"), "utf8");

/** The class lists of the rows split into two columns of different widths. */
const unevenRows = [...source.matchAll(/className="([^"]*@4xl:grid-cols-\[minmax[^"]*)"/g)].map((match) => match[1]!);

describe("a row of two unequal cards on the Costs page", () => {
  it("keeps each card its own height rather than stretching it to the taller one", () => {
    // The overview's ledgers, its agent and project spend, and the finance tab's row.
    expect(unevenRows.length).toBe(3);
    for (const row of unevenRows) {
      expect(row.split(/\s+/), row).toContain("items-start");
    }
  });
});
