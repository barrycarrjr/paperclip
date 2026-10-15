import { describe, expect, it } from "vitest";
import { formatRunCountsFooter, parseRunCountsFooter, readRunCounts } from "./run-counts.js";

describe("run count footer", () => {
  it.each([{ itemsRead: 0, entriesAdded: 0, changesProposed: 0 }, { itemsRead: 7, entriesAdded: 2, changesProposed: 1 }, { itemsRead: Number.MAX_SAFE_INTEGER, entriesAdded: 0, changesProposed: 0 }])("round trips explicit numeric counts (%j)", (counts) => {
    expect(parseRunCountsFooter(`Task report.\n\n${formatRunCountsFooter(counts)}\n`)).toEqual({ status: "reported", counts, reason: null });
  });
  it("emits and accepts only the required canonical footer", () => {
    expect(formatRunCountsFooter({ itemsRead: 1, entriesAdded: 2, changesProposed: 3 })).toBe("Counts: items read 1; entries added 2; changes proposed 3.");
    expect(parseRunCountsFooter("Counts: items read=1; entries added=2; changes proposed=3").status).toBe("invalid");
  });
  it.each([
    "```text\nA literal <!-- inside code.\n```\nCounts: items read 1; entries added 0; changes proposed 0.",
    "<!-- A literal ``` inside a comment. -->\nCounts: items read 1; entries added 0; changes proposed 0.",
  ])("accepts a final footer after closed hidden content (%s)", (comment) => {
    expect(parseRunCountsFooter(comment)).toEqual({
      status: "reported",
      counts: { itemsRead: 1, entriesAdded: 0, changesProposed: 0 },
      reason: null,
    });
  });
  it.each(["Task report only", "Counts: items read=1; entries added=0", "Counts: items read=-1; entries added=0; changes proposed=0", "Counts: items read=1.5; entries added=0; changes proposed=0", "Counts: items read 9007199254740992; entries added 0; changes proposed 0.", "Counts: items read=unknown; entries added=0; changes proposed=0", "Counts: items read 0; entries added 0; changes proposed 0.\nMore task text.", "```text\nCounts: items read 0; entries added 0; changes proposed 0.", "<!--\nCounts: items read 0; entries added 0; changes proposed 0.", "<!-- closed --> <!--\nCounts: items read 1; entries added 0; changes proposed 0.", "<!--\nclosed --> <!-- reopened\nCounts: items read 1; entries added 0; changes proposed 0.", "Counts: items read 1; entries added 0; changes proposed 0.\nCounts: items read 2; entries added 0; changes proposed 0."])("does not turn missing, ambiguous or invalid values into zero (%s)", (comment) => {
    const parsed = parseRunCountsFooter(comment);
    expect(parsed.status).not.toBe("reported");
    expect(parsed.counts).toBeNull();
  });
  it("validates stored values and formats only safe integer counts", () => {
    expect(readRunCounts({ itemsRead: 0, entriesAdded: 0, changesProposed: 0, source: "claim" })).toEqual({ itemsRead: 0, entriesAdded: 0, changesProposed: 0 });
    expect(readRunCounts({ itemsRead: "0", entriesAdded: 0, changesProposed: 0 })).toBeNull();
    expect(() => formatRunCountsFooter({ itemsRead: -1, entriesAdded: 0, changesProposed: 0 })).toThrow(RangeError);
  });
});
