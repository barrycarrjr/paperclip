// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  EMPTY_SELECTION,
  clearSelection,
  pruneSelection,
  selectAll,
  selectAllState,
  selectRange,
  selectedInOrder,
  toggleRow,
  type RowSelection,
} from "./row-selection";

const ROWS = ["a", "b", "c", "d", "e"];

function sel(ids: string[], anchorId: string | null = null): RowSelection {
  return { selected: new Set(ids), anchorId };
}

function ids(selection: RowSelection): string[] {
  return [...selection.selected].sort();
}

describe("toggleRow", () => {
  it("picks a row and remembers it as the anchor", () => {
    const next = toggleRow(EMPTY_SELECTION, "b");
    expect(ids(next)).toEqual(["b"]);
    expect(next.anchorId).toBe("b");
  });

  it("unpicks a row that was already picked", () => {
    const next = toggleRow(sel(["a", "b"]), "b");
    expect(ids(next)).toEqual(["a"]);
  });

  it("does not mutate what it was given", () => {
    const before = sel(["a"]);
    toggleRow(before, "b");
    expect(ids(before)).toEqual(["a"]);
  });
});

describe("selectRange", () => {
  it("takes everything between the anchor and the shift-clicked row", () => {
    const next = selectRange(sel(["b"], "b"), ROWS, "d");
    expect(ids(next)).toEqual(["b", "c", "d"]);
  });

  it("works upwards as well as downwards", () => {
    const next = selectRange(sel(["d"], "d"), ROWS, "b");
    expect(ids(next)).toEqual(["b", "c", "d"]);
  });

  it("keeps the anchor so a range can be redrawn", () => {
    const first = selectRange(sel(["b"], "b"), ROWS, "e");
    expect(first.anchorId).toBe("b");
    const second = selectRange(first, ROWS, "c");
    expect(second.anchorId).toBe("b");
  });

  it("only ever adds, so a range cannot silently unpick earlier work", () => {
    const next = selectRange(sel(["a", "b"], "b"), ROWS, "d");
    expect(ids(next)).toEqual(["a", "b", "c", "d"]);
  });

  it("behaves like a plain click when there is no anchor", () => {
    const next = selectRange(EMPTY_SELECTION, ROWS, "c");
    expect(ids(next)).toEqual(["c"]);
    expect(next.anchorId).toBe("c");
  });

  it("behaves like a plain click when the anchor has left the list", () => {
    // Someone else closed the anchor row, or a refetch dropped it. Guessing a
    // range from a row that is gone would select an arbitrary block.
    const next = selectRange(sel(["z"], "z"), ROWS, "c");
    expect(ids(next)).toEqual(["c", "z"]);
    expect(next.anchorId).toBe("c");
  });

  it("ignores a row that is not in the list", () => {
    const before = sel(["b"], "b");
    expect(selectRange(before, ROWS, "zzz")).toBe(before);
  });
});

describe("selectAll and clearSelection", () => {
  it("selects exactly the rows on screen", () => {
    expect(ids(selectAll(ROWS))).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("selects nothing when the list is empty", () => {
    const next = selectAll([]);
    expect(ids(next)).toEqual([]);
    expect(next.anchorId).toBeNull();
  });

  it("clears everything including the anchor", () => {
    const next = clearSelection();
    expect(ids(next)).toEqual([]);
    expect(next.anchorId).toBeNull();
  });
});

describe("pruneSelection", () => {
  it("drops rows that have left the list", () => {
    // The list refetches every 30 seconds and triage removes rows, so a
    // selection outlives the thing it points at unless it is pruned.
    const next = pruneSelection(sel(["a", "zz"], "a"), ROWS);
    expect(ids(next)).toEqual(["a"]);
  });

  it("forgets an anchor that has left", () => {
    const next = pruneSelection(sel(["a"], "zz"), ROWS);
    expect(next.anchorId).toBeNull();
  });

  it("returns the same object when nothing changed, so React does not re-render", () => {
    const before = sel(["a", "b"], "a");
    expect(pruneSelection(before, ROWS)).toBe(before);
  });

  it("empties the selection when every row is gone", () => {
    expect(ids(pruneSelection(sel(["a", "b"], "a"), []))).toEqual([]);
  });
});

describe("selectAllState", () => {
  it("reads none, some, or all", () => {
    expect(selectAllState(EMPTY_SELECTION, ROWS)).toBe("none");
    expect(selectAllState(sel(["a"]), ROWS)).toBe("some");
    expect(selectAllState(sel(ROWS), ROWS)).toBe("all");
  });

  it("is none for an empty list, whatever is selected", () => {
    expect(selectAllState(sel(["a"]), [])).toBe("none");
  });

  it("counts only rows on screen, so stale ids cannot fake a full selection", () => {
    expect(selectAllState(sel([...ROWS, "gone"]), ROWS)).toBe("all");
    expect(selectAllState(sel(["gone"]), ROWS)).toBe("none");
  });
});

describe("selectedInOrder", () => {
  it("returns the selected rows in the order they appear", () => {
    const rows = ROWS.map((id) => ({ id }));
    const picked = selectedInOrder(sel(["d", "a"]), rows, (row) => row.id);
    expect(picked.map((row) => row.id)).toEqual(["a", "d"]);
  });

  it("skips selected ids with no row", () => {
    const rows = [{ id: "a" }];
    expect(selectedInOrder(sel(["a", "gone"]), rows, (row) => row.id)).toHaveLength(1);
  });
});
