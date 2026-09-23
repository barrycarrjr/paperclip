import { describe, expect, it } from "vitest";
import type { ActivityEvent, Agent } from "@paperclipai/shared";
import { summarizeOutcome } from "./outcomes";

function event(overrides: Partial<ActivityEvent>): ActivityEvent {
  return {
    id: "evt-1",
    companyId: "c-1",
    actorType: "system",
    actorId: "adapter-model-refresh",
    entityType: "agent",
    entityId: "agent-1",
    action: "agent.paused",
    details: null,
    createdAt: new Date("2026-09-23T12:00:00Z"),
    ...overrides,
  } as ActivityEvent;
}

describe("summarizeOutcome for the daily model check", () => {
  const agentMap = new Map<string, Agent>([["agent-1", { id: "agent-1", name: "Coder" } as Agent]]);

  it("names the new model a provider started offering", () => {
    const outcome = summarizeOutcome(
      event({
        action: "model.available",
        entityType: "company",
        entityId: "c-1",
        details: { adapterType: "claude_local", model: "claude-opus-5-5", label: "Claude Opus 5.5" },
      }),
    );
    expect(outcome.verb).toBe("New model available:");
    expect(outcome.target).toBe("Claude Opus 5.5");
    expect(outcome.chip).toBe("new model");
  });

  it("asks a person to act on an agent whose model needs changing, by the agent's name", () => {
    const outcome = summarizeOutcome(
      event({ action: "agent.model_needs_update", details: { model: "gpt-5.5", state: "retiring" } }),
      { agentMap },
    );
    expect(outcome.verb).toBe("Model update needed for");
    expect(outcome.target).toBe("Coder");
    expect(outcome.tone).toBe("amber");
  });

  it("tells a model pause apart from a pause by hand", () => {
    const outcome = summarizeOutcome(event({ action: "agent.model_unavailable" }), { agentMap });
    expect(outcome.verb).toBe("Paused agent");
    expect(outcome.chip).toBe("model gone");
    expect(outcome.target).toBe("Coder");
  });
});
