import { describe, it, expect } from "vitest";
import { AGENT_TABS, agentTabLabel } from "./agent-tabs";

describe("agent tabs", () => {
  it("calls the first tab Current work, not Dashboard", () => {
    // Difference 11 of the mockup comparison. The Team page leads with what
    // each agent is doing right now and calls it current work, so the agent's
    // own page has to use the same words for the same thing.
    expect(AGENT_TABS[0]?.label).toBe("Current work");
    expect(AGENT_TABS.map((tab) => tab.label)).not.toContain("Dashboard");
  });

  it("keeps the first tab's address as dashboard so saved links still work", () => {
    // The label changed; the value is in the web address and must not.
    expect(AGENT_TABS[0]?.value).toBe("dashboard");
  });

  it("keeps every other tab exactly as it was", () => {
    expect(AGENT_TABS.map((tab) => tab.value)).toEqual([
      "dashboard",
      "instructions",
      "skills",
      "configuration",
      "runs",
      "budget",
    ]);
  });

  it("gives the breadcrumb the same words as the tab", () => {
    // These used to be typed out separately, so they could disagree.
    expect(agentTabLabel("dashboard")).toBe("Current work");
    expect(agentTabLabel("budget")).toBe("Budget");
  });

  it("has no label for a tab an add-on contributed", () => {
    // An add-on's tab is not in this list, and the breadcrumb falls back to
    // the add-on's own name rather than to a wrong one from here.
    expect(agentTabLabel("phone")).toBeNull();
  });
});
