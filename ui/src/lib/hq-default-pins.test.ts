// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  HQ_DEFAULT_PINNED_WORKSPACE_IDS,
  hasSeededHqDefaultPins,
  hqDefaultPinsSeededStorageKey,
  markHqDefaultPinsSeeded,
  mergeHqDefaultPins,
  planHqDefaultPinSeeding,
} from "./hq-default-pins";
import { CORE_WORKSPACE_CATALOG } from "./workspace-catalog";

/** A person who can store pins, in HQ, whose saved list has arrived. */
function readyInput(overrides: Partial<Parameters<typeof planHqDefaultPinSeeding>[0]> = {}) {
  return {
    isPortfolioRoot: true,
    canPin: true,
    pinsLoaded: true,
    ownerId: "user-1",
    pinned: [] as string[],
    hasSeeded: false,
    ...overrides,
  };
}

describe("HQ default pins", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("names eleven real pages, matching the Portfolio block that was removed", () => {
    expect(HQ_DEFAULT_PINNED_WORKSPACE_IDS).toHaveLength(11);
    const catalogIds = new Set(CORE_WORKSPACE_CATALOG.map((entry) => entry.id));
    for (const id of HQ_DEFAULT_PINNED_WORKSPACE_IDS) {
      expect(catalogIds, id).toContain(id);
    }
  });

  it("gives a brand new person all eleven", () => {
    const plan = planHqDefaultPinSeeding(readyInput());
    expect(plan).toEqual({ action: "write", orderedIds: [...HQ_DEFAULT_PINNED_WORKSPACE_IDS] });
  });

  it("adds to what someone already pinned instead of replacing it", () => {
    const plan = planHqDefaultPinSeeding(readyInput({ pinned: ["goals", "notepad"] }));
    expect(plan.action).toBe("write");
    if (plan.action !== "write") throw new Error("expected a write");
    expect(plan.orderedIds.slice(0, 2)).toEqual(["goals", "notepad"]);
    expect(plan.orderedIds).toHaveLength(2 + HQ_DEFAULT_PINNED_WORKSPACE_IDS.length);
  });

  it("does not pin the same page twice when one of them is already there", () => {
    const plan = planHqDefaultPinSeeding(readyInput({ pinned: ["portfolio-costs", "goals"] }));
    expect(plan.action).toBe("write");
    if (plan.action !== "write") throw new Error("expected a write");
    expect(plan.orderedIds.filter((id) => id === "portfolio-costs")).toHaveLength(1);
    expect(plan.orderedIds[0]).toBe("portfolio-costs");
    expect(new Set(plan.orderedIds).size).toBe(plan.orderedIds.length);
  });

  it("only has something to mark when every default is already pinned", () => {
    const plan = planHqDefaultPinSeeding(
      readyInput({ pinned: [...HQ_DEFAULT_PINNED_WORKSPACE_IDS] }),
    );
    expect(plan).toEqual({ action: "mark-only" });
  });

  it("leaves an ordinary company alone", () => {
    expect(planHqDefaultPinSeeding(readyInput({ isPortfolioRoot: false }))).toEqual({
      action: "none",
    });
  });

  it("does nothing at all for someone who cannot store pins", () => {
    // Not even a mark. A signed out person who signs in later must still get
    // the defaults the first time they can actually keep them.
    expect(planHqDefaultPinSeeding(readyInput({ canPin: false }))).toEqual({ action: "none" });
    expect(planHqDefaultPinSeeding(readyInput({ ownerId: null }))).toEqual({ action: "none" });
    markHqDefaultPinsSeeded(null);
    expect(window.localStorage.getItem(hqDefaultPinsSeededStorageKey("null"))).toBeNull();
    // So once they can store pins, they still get the defaults.
    expect(hasSeededHqDefaultPins("user-1")).toBe(false);
  });

  it("waits for the saved list to arrive before writing anything", () => {
    // Treating a list that has not loaded as empty would write the defaults
    // over pins the person already has.
    expect(planHqDefaultPinSeeding(readyInput({ pinsLoaded: false }))).toEqual({ action: "none" });
  });

  it("keeps an unpinned page unpinned after a reload", () => {
    // The whole point of the mark. Seed once, unpin one page, come back.
    const first = planHqDefaultPinSeeding(readyInput());
    expect(first.action).toBe("write");
    if (first.action !== "write") throw new Error("expected a write");
    markHqDefaultPinsSeeded("user-1");

    const afterUnpinning = first.orderedIds.filter((id) => id !== "portfolio-costs");

    // A reload: fresh page, same browser, same person, pins read back from the
    // server. hasSeeded is read from storage exactly as the hook reads it.
    const second = planHqDefaultPinSeeding(
      readyInput({
        pinned: afterUnpinning,
        hasSeeded: hasSeededHqDefaultPins("user-1"),
      }),
    );

    expect(second).toEqual({ action: "none" });
    expect(afterUnpinning).not.toContain("portfolio-costs");
  });

  it("would put them all back if the mark were not there", () => {
    // Proves the test above is testing the mark and not something else.
    const withoutTheMark = planHqDefaultPinSeeding(
      readyInput({
        pinned: HQ_DEFAULT_PINNED_WORKSPACE_IDS.filter((id) => id !== "portfolio-costs"),
        hasSeeded: false,
      }),
    );
    expect(withoutTheMark.action).toBe("write");
  });

  it("keeps unpinning working even when the person unpins every one of them", () => {
    markHqDefaultPinsSeeded("user-1");
    expect(
      planHqDefaultPinSeeding(readyInput({ pinned: [], hasSeeded: hasSeededHqDefaultPins("user-1") })),
    ).toEqual({ action: "none" });
  });

  it("remembers per person, so two people on one computer do not share it", () => {
    markHqDefaultPinsSeeded("user-1");
    expect(hasSeededHqDefaultPins("user-1")).toBe(true);
    expect(hasSeededHqDefaultPins("user-2")).toBe(false);
    expect(window.localStorage.getItem(hqDefaultPinsSeededStorageKey("user-1"))).not.toBeNull();
  });

  it("reports not seeded when nobody can be identified", () => {
    expect(hasSeededHqDefaultPins(null)).toBe(false);
  });

  it("merges on its own without reordering anything", () => {
    expect(mergeHqDefaultPins(["goals"])).toEqual(["goals", ...HQ_DEFAULT_PINNED_WORKSPACE_IDS]);
    expect(mergeHqDefaultPins([...HQ_DEFAULT_PINNED_WORKSPACE_IDS])).toEqual([
      ...HQ_DEFAULT_PINNED_WORKSPACE_IDS,
    ]);
  });
});
