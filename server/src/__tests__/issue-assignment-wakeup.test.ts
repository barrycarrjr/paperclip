import { describe, expect, it } from "vitest";
import { buildIssueAssignmentWakeup } from "../services/issue-assignment-wakeup";

const issueId = "11111111-1111-4111-8111-111111111111";
const workerId = "22222222-2222-4222-8222-222222222222";
const reviewerId = "33333333-3333-4333-8333-333333333333";
const stageId = "44444444-4444-4444-8444-444444444444";

function pendingState() {
  return {
    status: "pending",
    currentStageId: stageId,
    currentStageIndex: 0,
    currentStageType: "review",
    currentParticipant: { type: "agent", agentId: reviewerId },
    returnAssignee: { type: "agent", agentId: workerId },
    completedStageIds: [],
    reviewRequest: { instructions: "Check the acceptance criteria." },
    lastDecisionId: null,
    lastDecisionOutcome: null,
  };
}

describe("buildIssueAssignmentWakeup", () => {
  it("gives a reviewer the execution-stage context on creation", () => {
    const result = buildIssueAssignmentWakeup({
      issue: {
        id: issueId,
        status: "in_review",
        assigneeAgentId: reviewerId,
        executionState: pendingState(),
      },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    expect(result).toMatchObject({
      agentId: reviewerId,
      wakeup: {
        reason: "execution_review_requested",
        payload: {
          mutation: "create",
          executionStage: {
            wakeRole: "reviewer",
            stageId,
            reviewRequest: { instructions: "Check the acceptance criteria." },
            allowedActions: ["approve", "request_changes"],
          },
        },
        contextSnapshot: {
          source: "issue.execution_stage",
          executionStage: { returnAssignee: { type: "agent", agentId: workerId } },
        },
      },
    });
  });

  it("gives the executor the requested-changes context", () => {
    const state = {
      ...pendingState(),
      status: "changes_requested",
      lastDecisionId: "55555555-5555-4555-8555-555555555555",
      lastDecisionOutcome: "changes_requested",
    };
    const result = buildIssueAssignmentWakeup({
      issue: {
        id: issueId,
        status: "in_progress",
        assigneeAgentId: workerId,
        executionState: state,
      },
      previousExecutionState: pendingState(),
      reason: "issue_assigned",
      mutation: "update",
      contextSource: "issue.update",
      executionStageOnly: true,
      requestedByActorType: "agent",
      requestedByActorId: reviewerId,
    });

    expect(result).toMatchObject({
      agentId: workerId,
      wakeup: {
        reason: "execution_changes_requested",
        payload: {
          executionStage: {
            wakeRole: "executor",
            lastDecisionOutcome: "changes_requested",
            allowedActions: ["address_changes", "resubmit"],
          },
        },
      },
    });
  });

  it("does not repeat a wakeup for an unchanged execution stage", () => {
    const state = pendingState();
    expect(buildIssueAssignmentWakeup({
      issue: {
        id: issueId,
        status: "in_review",
        assigneeAgentId: reviewerId,
        executionState: state,
      },
      previousExecutionState: state,
      reason: "issue_assigned",
      mutation: "update",
      contextSource: "issue.update",
      executionStageOnly: true,
    })).toBeNull();
  });
});
