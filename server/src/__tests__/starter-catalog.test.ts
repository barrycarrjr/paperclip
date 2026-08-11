import { describe, expect, it } from "vitest";
import { STARTER_CARDS } from "@paperclipai/shared";
import { starterRoutineMarker } from "../services/starter-catalog.js";

/**
 * The service's database-touching paths are covered by the live end-to-end
 * check (activate a card, assert a routine exists, is scheduled, and has run).
 * What is worth pinning here is the part that would silently rot: the marker
 * used to recognise a company's existing starter routines.
 */
describe("starter routine marker", () => {
  it("round-trips every card id", () => {
    for (const card of STARTER_CARDS) {
      const marker = starterRoutineMarker(card.id);
      expect(marker).toContain(card.id);
      // Must survive being embedded in a routine description and found again.
      const description = `Some instructions.\n\n${marker}`;
      expect(description.includes(marker)).toBe(true);
    }
  });

  it("does not collide between cards", () => {
    const markers = STARTER_CARDS.map((c) => starterRoutineMarker(c.id));
    expect(new Set(markers).size).toBe(markers.length);
  });

  it("stays invisible in rendered markdown", () => {
    // An HTML comment so the operator reading the routine never sees it.
    expect(starterRoutineMarker("x")).toMatch(/^<!--.*-->$/);
  });

  it("does not match a different card's marker by prefix", () => {
    // "call-web-form-leads" must not be found inside a description carrying
    // "call-web-form-leads-extra", or switching one card on would report the
    // other as already active.
    const base = starterRoutineMarker("call-web-form-leads");
    const longer = starterRoutineMarker("call-web-form-leads-extra");
    expect(longer.includes(base)).toBe(false);
  });
});
