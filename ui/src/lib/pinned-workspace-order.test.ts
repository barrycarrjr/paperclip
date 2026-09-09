import { describe, expect, it } from "vitest";
import { reorderPinnedIds } from "./pinned-workspace-order";

describe("reorderPinnedIds", () => {
  it("moves the dragged id to sit where it was dropped", () => {
    const pinned = ["brief", "approvals", "issues", "email"];
    const next = reorderPinnedIds(pinned, "email", "approvals", pinned);
    expect(next).toEqual(["brief", "email", "approvals", "issues"]);
  });

  it("moving forward and moving backward land on the same order", () => {
    const pinned = ["a", "b", "c", "d"];
    // Dragging "a" to sit where "c" is should read the same as dragging "c"
    // to sit where "a" was minus one.
    expect(reorderPinnedIds(pinned, "a", "c", pinned)).toEqual(["b", "c", "a", "d"]);
  });

  it("leaves a pin the current company cannot show exactly where it was", () => {
    // "plugin-x" is pinned but not available here, so it never appears in
    // visibleIds. It must not shift even though everything around it moves.
    const pinned = ["brief", "plugin-x", "approvals", "issues"];
    const visibleIds = ["brief", "approvals", "issues"];
    const next = reorderPinnedIds(pinned, "issues", "brief", visibleIds);
    expect(next).toEqual(["issues", "plugin-x", "brief", "approvals"]);
  });

  it("returns the same reference, unchanged, for a drop back on itself", () => {
    const pinned = ["brief", "approvals"];
    expect(reorderPinnedIds(pinned, "brief", "brief", pinned)).toBe(pinned);
  });

  it("returns the same reference, unchanged, when either id is not visible", () => {
    const pinned = ["brief", "approvals"];
    expect(reorderPinnedIds(pinned, "brief", "ghost", pinned)).toBe(pinned);
    expect(reorderPinnedIds(pinned, "ghost", "brief", pinned)).toBe(pinned);
  });
});
