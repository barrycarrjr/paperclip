import { describe, expect, it } from "vitest";
import { agentActivityToShow, isAgentBookkeepingEvent } from "./agent-activity-filter";

function event(action: string) {
  return { action };
}

describe("isAgentBookkeepingEvent", () => {
  it("knows the machinery from the work", () => {
    expect(isAgentBookkeepingEvent(event("environment.lease_acquired"))).toBe(true);
    expect(isAgentBookkeepingEvent(event("environment.lease_released"))).toBe(true);
    expect(isAgentBookkeepingEvent(event("issue.commented"))).toBe(false);
    expect(isAgentBookkeepingEvent(event("issue.status_changed"))).toBe(false);
  });
});

describe("agentActivityToShow", () => {
  it("drops the workspace leases so the real events are not pushed off", () => {
    const events = [
      event("environment.lease_released"),
      event("issue.commented"),
      event("environment.lease_acquired"),
      event("issue.status_changed"),
    ];

    expect(agentActivityToShow(events, 20).map((e) => e.action)).toEqual([
      "issue.commented",
      "issue.status_changed",
    ]);
  });

  it("keeps the order it was given", () => {
    const events = [event("issue.commented"), event("issue.status_changed")];
    expect(agentActivityToShow(events, 20)).toEqual(events);
  });

  it("stops at the limit", () => {
    const events = Array.from({ length: 50 }, () => event("issue.commented"));
    expect(agentActivityToShow(events, 20)).toHaveLength(20);
  });

  it("shows the bookkeeping rather than an empty panel when that is all there is", () => {
    const events = [event("environment.lease_acquired"), event("environment.lease_released")];
    expect(agentActivityToShow(events, 20)).toHaveLength(2);
  });

  it("says nothing when there is nothing", () => {
    expect(agentActivityToShow([], 20)).toEqual([]);
  });
});
