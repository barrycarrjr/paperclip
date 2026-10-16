import { describe, expect, it, vi } from "vitest";
import { isVerifiedIssueTreeControlInteractionWake, issueTreeControlService } from "../services/issue-tree-control.js";

function emptySelectDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve([])),
        })),
      })),
    })),
  };
}

function interactionDb(intent: "message" | "correction", requestActor?: { requestedByActorType: string; requestedByActorId: string }) {
  let selection = 0;
  return {
    select: vi.fn(() => ({ from: () => ({ where: () => Promise.resolve(++selection === 1
      ? [{ id: "comment-1", intent, authorAgentId: null, authorUserId: "board-user" }]
      : requestActor ? [requestActor] : []) }) })),
  };
}

const correctionInteraction = {
  companyId: "company-1", issueId: "issue-1", agentId: "agent-1",
  contextSnapshot: { wakeReason: "issue_assigned", source: "issue.comment.correction", wakeCommentId: "comment-1" },
};

describe("issueTreeControlService unit guards", () => {
  it("rejects cross-company roots before traversing descendants", async () => {
    const db = emptySelectDb();
    const svc = issueTreeControlService(db as any);

    await expect(svc.preview("company-2", "issue-from-company-1", { mode: "pause" })).rejects.toMatchObject({
      status: 404,
    });
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("does not accept an ordinary comment as proof of a correction assignment", async () => {
    expect(await isVerifiedIssueTreeControlInteractionWake(interactionDb("message") as any, {
      ...correctionInteraction, requestedByActorType: "user", requestedByActorId: "board-user",
    })).toBe(false);
  });

  it.each(["agent", "system"])("rejects persisted %s requests spoofing a user correction", async (requestedByActorType) => {
    expect(await isVerifiedIssueTreeControlInteractionWake(interactionDb("correction", {
      requestedByActorType, requestedByActorId: "board-user",
    }) as any, { ...correctionInteraction, wakeupRequestId: "wake-1" })).toBe(false);
  });

  it("verifies the persisted human request when an agent checks out its correction run", async () => {
    expect(await isVerifiedIssueTreeControlInteractionWake(interactionDb("correction", {
      requestedByActorType: "user", requestedByActorId: "board-user",
    }) as any, {
      ...correctionInteraction, requestedByActorType: "agent", requestedByActorId: "agent-1", wakeupRequestId: "wake-1",
    })).toBe(true);
  });
});
