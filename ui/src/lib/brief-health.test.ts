import { describe, expect, it } from "vitest";
import { ALL_CLEAR_HEADLINE, briefHealth, type BriefHealthCounts } from "./brief-health";

function counts(overrides: Partial<BriefHealthCounts> = {}): BriefHealthCounts {
  return {
    agentErrors: 0,
    budgetIncidents: 0,
    blockedTasks: 0,
    waitingOnYou: 0,
    pendingApprovals: 0,
    ...overrides,
  };
}

describe("briefHealth", () => {
  it("is green only when nothing at all is wrong", () => {
    const health = briefHealth(counts());
    expect(health.tone).toBe("green");
    expect(health.headline).toBe(ALL_CLEAR_HEADLINE);
    expect(health.parts).toEqual([]);
  });

  // Seen live: "All systems green." over a company with nine blocked tasks
  // and forty rows waiting in Attention, because only agent errors counted.
  it("does not call blocked and waiting work all clear", () => {
    const health = briefHealth(counts({ blockedTasks: 9, waitingOnYou: 40 }));
    expect(health.tone).toBe("amber");
    expect(health.headline).toBe("9 tasks blocked, 40 waiting on you.");
  });

  it("turns amber for a single blocked task", () => {
    const health = briefHealth(counts({ blockedTasks: 1 }));
    expect(health.tone).toBe("amber");
    expect(health.headline).toBe("1 task blocked.");
  });

  // Seen live: "1 agent error." beside a green dot.
  it("turns red for an agent in error", () => {
    const health = briefHealth(counts({ agentErrors: 1 }));
    expect(health.tone).toBe("red");
    expect(health.headline).toBe("1 agent in error.");
  });

  // Most open incidents are warnings at the warn percent, not a stop, so the
  // line says "incident" (the Overview banner's word) rather than "limit hit".
  it("turns amber, not red, for a budget incident with no agent errors", () => {
    const health = briefHealth(counts({ budgetIncidents: 2, waitingOnYou: 1 }));
    expect(health.tone).toBe("amber");
    expect(health.headline).toBe("2 budget incidents, 1 waiting on you.");
    expect(briefHealth(counts({ budgetIncidents: 1 })).headline).toBe("1 budget incident.");
  });

  it("names the worst thing first", () => {
    const health = briefHealth(
      counts({ agentErrors: 2, budgetIncidents: 1, blockedTasks: 3, waitingOnYou: 4 }),
    );
    expect(health.parts.map((part) => part.kind)).toEqual([
      "agentErrors",
      "budgetIncidents",
      "blockedTasks",
      "waitingOnYou",
    ]);
    expect(health.headline).toBe(
      "2 agents in error, 1 budget incident, 3 tasks blocked, 4 waiting on you.",
    );
  });

  // An approval the operator can decide is already a row in the queue, so
  // naming it again would count one approval twice in the same line.
  it("does not count approvals twice when the queue already holds them", () => {
    const health = briefHealth(counts({ waitingOnYou: 3, pendingApprovals: 2 }));
    expect(health.headline).toBe("3 waiting on you.");
  });

  it("still names pending approvals when the queue is empty", () => {
    const health = briefHealth(counts({ pendingApprovals: 1 }));
    expect(health.tone).toBe("amber");
    expect(health.headline).toBe("1 approval pending.");
  });

  // One hard stop makes one incident and one budget override approval. The
  // summary's pendingApprovals already holds that approval, so passing it
  // alone names it once (with the queue row snoozed, so the queue is empty).
  it("names one budget override as one approval", () => {
    const health = briefHealth(counts({ budgetIncidents: 1, pendingApprovals: 1 }));
    expect(health.headline).toBe("1 budget incident, 1 approval pending.");
  });
});
