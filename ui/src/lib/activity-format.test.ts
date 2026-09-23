import type { Agent } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import {
  activityNamesEntity,
  formatActivityReason,
  formatActivityVerb,
  formatIssueActivityAction,
} from "./activity-format";

describe("activity formatting", () => {
  const agentMap = new Map<string, Agent>([
    ["agent-reviewer", { id: "agent-reviewer", name: "Reviewer Bot" } as Agent],
    ["agent-approver", { id: "agent-approver", name: "Approver Bot" } as Agent],
  ]);

  it("formats blocker activity using linked issue identifiers", () => {
    const details = {
      addedBlockedByIssues: [
        { id: "issue-2", identifier: "PAP-22", title: "Blocked task" },
      ],
      removedBlockedByIssues: [],
    };

    expect(formatActivityVerb("issue.blockers_updated", details)).toBe("added blocker PAP-22 to");
    expect(formatIssueActivityAction("issue.blockers_updated", details)).toBe("added blocker PAP-22");
  });

  it("formats reviewer activity using agent names", () => {
    const details = {
      addedParticipants: [
        { type: "agent", agentId: "agent-reviewer", userId: null },
      ],
      removedParticipants: [],
    };

    expect(formatActivityVerb("issue.reviewers_updated", details, { agentMap })).toBe("added reviewer Reviewer Bot to");
    expect(formatIssueActivityAction("issue.reviewers_updated", details, { agentMap })).toBe("added reviewer Reviewer Bot");
  });

  it("formats approver removals using user-aware labels", () => {
    const details = {
      addedParticipants: [],
      removedParticipants: [
        { type: "user", agentId: null, userId: "local-board" },
      ],
    };

    expect(formatActivityVerb("issue.approvers_updated", details)).toBe("removed approver Board from");
    expect(formatIssueActivityAction("issue.approvers_updated", details)).toBe("removed approver Board");
  });

  it("words the daily model check's events", () => {
    expect(formatActivityVerb("agent.model_needs_update", { state: "retiring" })).toBe("flagged a model update for");
    expect(formatActivityVerb("model.available", { model: "claude-opus-5-5", label: "Claude Opus 5.5" })).toBe(
      "found a new model: Claude Opus 5.5",
    );
    expect(formatActivityVerb("model.available", { model: "gpt-6-astra" })).toBe("found a new model: gpt-6-astra");
    expect(formatActivityVerb("model.available", null)).toBe("found a new model");
    // The verb names the model, so the company it was recorded against is left off.
    expect(activityNamesEntity("model.available")).toBe(false);
    expect(activityNamesEntity("agent.model_needs_update")).toBe(true);
  });

  it("gives the recorded reason for a model that is gone, replaced or retiring", () => {
    const reason = "GPT-5.5 is retiring on 2026-10-14. Consider switching to GPT-5.6 Sol.";
    expect(formatActivityReason("agent.model_needs_update", { reason })).toBe(reason);
    expect(formatActivityReason("agent.model_unavailable", { reason: "  The model is gone.  " })).toBe(
      "The model is gone.",
    );
    expect(formatActivityReason("agent.model_unavailable", {})).toBeNull();
    // Other events keep their details to themselves.
    expect(formatActivityReason("agent.paused", { reason: "budget" })).toBeNull();
  });

  it("falls back to updated wording when reviewers are both added and removed", () => {
    const details = {
      addedParticipants: [
        { type: "agent", agentId: "agent-reviewer", userId: null },
      ],
      removedParticipants: [
        { type: "agent", agentId: "agent-approver", userId: null },
      ],
    };

    expect(formatActivityVerb("issue.reviewers_updated", details, { agentMap })).toBe("updated reviewers on");
    expect(formatIssueActivityAction("issue.reviewers_updated", details, { agentMap })).toBe("updated reviewers");
  });
});
