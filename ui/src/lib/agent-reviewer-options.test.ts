import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { getAutomaticReviewerOptions } from "./agent-reviewer-options";

function agent(id: string, name: string, status: Agent["status"]): Agent {
  return { id, name, status } as Agent;
}

describe("getAutomaticReviewerOptions", () => {
  it("keeps a saved terminated reviewer visible so the setting can be cleared", () => {
    expect(getAutomaticReviewerOptions([
      agent("worker", "Worker", "idle"),
      agent("reviewer", "Old reviewer", "terminated"),
    ], "worker", "reviewer")).toEqual([
      { id: "reviewer", label: "Old reviewer (unavailable)", unavailable: true },
    ]);
  });

  it("offers only available agents plus an unavailable saved reviewer", () => {
    expect(getAutomaticReviewerOptions([
      agent("worker", "Worker", "idle"),
      agent("available", "Available reviewer", "idle"),
      agent("pending", "Pending reviewer", "pending_approval"),
    ], "worker", "missing")).toEqual([
      { id: "available", label: "Available reviewer", unavailable: false },
      { id: "missing", label: "Saved reviewer (unavailable)", unavailable: true },
    ]);
  });
});
