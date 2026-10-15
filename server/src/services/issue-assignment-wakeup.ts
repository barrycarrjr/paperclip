import { logger } from "../middleware/logger.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";

type WakeupTriggerDetail = "manual" | "ping" | "callback" | "system";
type WakeupSource = "timer" | "assignment" | "on_demand" | "automation";

export interface IssueAssignmentWakeupDeps {
  wakeup: (
    agentId: string,
    opts: {
      source?: WakeupSource;
      triggerDetail?: WakeupTriggerDetail;
      reason?: string | null;
      payload?: Record<string, unknown> | null;
      requestedByActorType?: "user" | "agent" | "system";
      requestedByActorId?: string | null;
      contextSnapshot?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
}

type ParsedExecutionState = NonNullable<ReturnType<typeof parseIssueExecutionState>>;

function executionPrincipalsEqual(
  left: ParsedExecutionState["currentParticipant"] | null,
  right: ParsedExecutionState["currentParticipant"] | null,
) {
  if (!left || !right || left.type !== right.type) return false;
  return left.type === "agent" ? left.agentId === right.agentId : left.userId === right.userId;
}

function buildExecutionStageContext(
  state: ParsedExecutionState,
  wakeRole: "reviewer" | "approver" | "executor",
  allowedActions: string[],
) {
  return {
    wakeRole,
    stageId: state.currentStageId,
    stageType: state.currentStageType,
    currentParticipant: state.currentParticipant,
    returnAssignee: state.returnAssignee,
    reviewRequest: state.reviewRequest ?? null,
    lastDecisionOutcome: state.lastDecisionOutcome,
    allowedActions,
  };
}

export function buildIssueAssignmentWakeup(input: {
  issue: {
    id: string;
    assigneeAgentId: string | null;
    status: string;
    executionState?: unknown;
  };
  previousExecutionState?: unknown;
  reason: string;
  mutation: string;
  contextSource: string;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  interruptedRunId?: string | null;
  executionStageOnly?: boolean;
}) {
  const previousState = parseIssueExecutionState(input.previousExecutionState ?? null);
  const nextState = parseIssueExecutionState(input.issue.executionState ?? null);

  if (nextState?.status === "pending") {
    const agentId = nextState.currentParticipant?.type === "agent"
      ? nextState.currentParticipant.agentId ?? null
      : null;
    const stageChanged =
      previousState?.status !== "pending"
      || previousState.currentStageId !== nextState.currentStageId
      || !executionPrincipalsEqual(previousState.currentParticipant ?? null, nextState.currentParticipant ?? null);
    if (agentId && stageChanged) {
      const reason = nextState.currentStageType === "approval"
        ? "execution_approval_requested"
        : "execution_review_requested";
      const executionStage = buildExecutionStageContext(
        nextState,
        nextState.currentStageType === "approval" ? "approver" : "reviewer",
        ["approve", "request_changes"],
      );
      return {
        agentId,
        wakeup: {
          source: "assignment" as const,
          triggerDetail: "system" as const,
          reason,
          payload: {
            issueId: input.issue.id,
            mutation: input.mutation,
            executionStage,
            ...(input.interruptedRunId ? { interruptedRunId: input.interruptedRunId } : {}),
          },
          requestedByActorType: input.requestedByActorType,
          requestedByActorId: input.requestedByActorId ?? null,
          contextSnapshot: {
            issueId: input.issue.id,
            taskId: input.issue.id,
            wakeReason: reason,
            source: "issue.execution_stage",
            executionStage,
            ...(input.interruptedRunId ? { interruptedRunId: input.interruptedRunId } : {}),
          },
        },
      };
    }
  }

  if (nextState?.status === "changes_requested") {
    const agentId = nextState.returnAssignee?.type === "agent"
      ? nextState.returnAssignee.agentId ?? null
      : null;
    const stateChanged =
      previousState?.status !== "changes_requested"
      || previousState.lastDecisionId !== nextState.lastDecisionId
      || !executionPrincipalsEqual(previousState.returnAssignee ?? null, nextState.returnAssignee ?? null);
    if (agentId && stateChanged) {
      const reason = "execution_changes_requested";
      const executionStage = buildExecutionStageContext(
        nextState,
        "executor",
        ["address_changes", "resubmit"],
      );
      return {
        agentId,
        wakeup: {
          source: "assignment" as const,
          triggerDetail: "system" as const,
          reason,
          payload: {
            issueId: input.issue.id,
            mutation: input.mutation,
            executionStage,
            ...(input.interruptedRunId ? { interruptedRunId: input.interruptedRunId } : {}),
          },
          requestedByActorType: input.requestedByActorType,
          requestedByActorId: input.requestedByActorId ?? null,
          contextSnapshot: {
            issueId: input.issue.id,
            taskId: input.issue.id,
            wakeReason: reason,
            source: "issue.execution_stage",
            executionStage,
            ...(input.interruptedRunId ? { interruptedRunId: input.interruptedRunId } : {}),
          },
        },
      };
    }
  }

  if (input.executionStageOnly || !input.issue.assigneeAgentId || input.issue.status === "backlog") {
    return null;
  }

  return {
    agentId: input.issue.assigneeAgentId,
    wakeup: {
      source: "assignment" as const,
      triggerDetail: "system" as const,
      reason: input.reason,
      payload: { issueId: input.issue.id, mutation: input.mutation },
      requestedByActorType: input.requestedByActorType,
      requestedByActorId: input.requestedByActorId ?? null,
      contextSnapshot: { issueId: input.issue.id, source: input.contextSource },
    },
  };
}

export function queueIssueAssignmentWakeup(input: {
  heartbeat: IssueAssignmentWakeupDeps;
  issue: { id: string; assigneeAgentId: string | null; status: string; executionState?: unknown };
  reason: string;
  mutation: string;
  contextSource: string;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  rethrowOnError?: boolean;
  previousExecutionState?: unknown;
  interruptedRunId?: string | null;
  executionStageOnly?: boolean;
}) {
  const built = buildIssueAssignmentWakeup(input);
  if (!built) return;

  return input.heartbeat
    .wakeup(built.agentId, built.wakeup)
    .catch((err) => {
      logger.warn({ err, issueId: input.issue.id }, "failed to wake assignee on issue assignment");
      if (input.rethrowOnError) throw err;
      return null;
    });
}
