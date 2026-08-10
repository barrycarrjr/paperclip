// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { readLsFilter, writeLsFilter } from "./persistFilter";

const KEY = "paperclip:calendar:hiddenSources";

/** How both calendar pages rebuild the hidden-source set on load. */
function restoreHiddenSources(): Set<string> {
  const stored = readLsFilter<string[]>(KEY, []);
  return new Set(Array.isArray(stored) ? stored : []);
}

describe("hidden calendar sources survive a refresh", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("shows every source when nothing has been hidden yet", () => {
    expect(restoreHiddenSources().size).toBe(0);
  });

  // Switching Routines off then refreshing used to bring them straight back.
  it("remembers a source that was switched off", () => {
    writeLsFilter(KEY, [...new Set(["routine"])]);

    const restored = restoreHiddenSources();
    expect(restored.has("routine")).toBe(true);
    expect(restored.has("paperclip")).toBe(false);
  });

  it("remembers several at once", () => {
    writeLsFilter(KEY, ["routine", "google"]);

    expect([...restoreHiddenSources()].sort()).toEqual(["google", "routine"]);
  });

  it("comes back empty rather than throwing on a value it cannot use", () => {
    localStorage.setItem(KEY, "not json at all");
    expect(restoreHiddenSources().size).toBe(0);

    // A Set constructor throws on a number, so the shape check earns its keep.
    localStorage.setItem(KEY, "42");
    expect(restoreHiddenSources().size).toBe(0);
  });
});
