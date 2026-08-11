import { describe, expect, it } from "vitest";
import {
  STARTER_CARDS,
  STARTER_CATEGORIES,
  findStarterCard,
  searchStarterCards,
} from "./starter-catalog.js";

describe("starter catalog", () => {
  it("gives every card a category that exists", () => {
    const ids = new Set(STARTER_CATEGORIES.map((c) => c.id));
    for (const card of STARTER_CARDS) {
      expect(ids.has(card.category), `${card.id} -> ${card.category}`).toBe(true);
    }
  });

  it("has no duplicate card ids", () => {
    const ids = STARTER_CARDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("states what every card does, when, and what it needs", () => {
    // The third line is the one the design calls out as missing everywhere
    // else: the price of admission, before you commit. `requiresPlugins` may
    // legitimately be empty, but the field has to be present and an array.
    for (const card of STARTER_CARDS) {
      expect(card.title.length, card.id).toBeGreaterThan(0);
      expect(card.what.length, card.id).toBeGreaterThan(0);
      expect(card.when.length, card.id).toBeGreaterThan(0);
      expect(Array.isArray(card.requiresPlugins), card.id).toBe(true);
    }
  });

  it("gives every card a valid 5-field cron and a timezone", () => {
    for (const card of STARTER_CARDS) {
      const fields = card.routine.cron.trim().split(/\s+/);
      expect(fields.length, `${card.id}: "${card.routine.cron}"`).toBe(5);
      expect(card.routine.timezone.length, card.id).toBeGreaterThan(0);
    }
  });

  it("writes routine instructions, not just a title", () => {
    // A card whose routine body is a stub would create a routine that runs and
    // produces nothing — the dead card this catalog is meant to prevent.
    for (const card of STARTER_CARDS) {
      expect(card.routine.description.length, card.id).toBeGreaterThan(80);
    }
  });

  it("finds a card by id and returns null for an unknown one", () => {
    expect(findStarterCard("reply-google-reviews")?.category).toBe("get-found");
    expect(findStarterCard("no-such-card")).toBeNull();
  });

  describe("free-text search", () => {
    it("matches the words someone would actually type", () => {
      expect(searchStarterCards("google reviews")[0]?.id).toBe("reply-google-reviews");
      expect(searchStarterCards("missed appointment")[0]?.id).toBe("call-back-no-shows");
      expect(searchStarterCards("support numbers")[0]?.id).toBe("daily-support-numbers");
    });

    it("matches on the card's extra terms, not just its title", () => {
      // "pbx" appears nowhere in the phone report's title or blurb.
      expect(searchStarterCards("pbx")[0]?.id).toBe("daily-phone-report");
    });

    it("returns nothing for a phrase the catalog doesn't cover", () => {
      // Not a failure: the caller hands these to the CEO as a plain request,
      // so no wording is ever a dead end.
      expect(searchStarterCards("book me a flight to tokyo")).toEqual([]);
    });

    it("ignores noise words too short to mean anything", () => {
      expect(searchStarterCards("a to of")).toEqual([]);
    });

    it("ranks a card matching more words above one matching fewer", () => {
      const results = searchStarterCards("daily phone calls abandoned");
      expect(results[0]?.id).toBe("daily-phone-report");
    });
  });
});
