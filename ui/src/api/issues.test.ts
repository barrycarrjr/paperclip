import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { issuesApi } from "./issues";

describe("issuesApi.list", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.post.mockReset();
    mockApi.patch.mockReset();
    mockApi.get.mockResolvedValue([]);
  });

  it("passes parentId through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", { parentId: "issue-parent-1", limit: 25 });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?parentId=issue-parent-1&limit=25",
    );
  });

  it("passes descendantOf through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", { descendantOf: "issue-root-1", includeBlockedBy: true, limit: 25 });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?descendantOf=issue-root-1&includeBlockedBy=true&limit=25",
    );
  });

  it("passes generic workspaceId filters through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", { workspaceId: "workspace-1", limit: 1000 });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?workspaceId=workspace-1&limit=1000",
    );
  });
});

describe("issuesApi.addComment", () => {
  it("sends a stable idempotency key for a correction", async () => {
    mockApi.post.mockResolvedValue({});

    await issuesApi.addComment(
      "issue-1",
      "Check the source.",
      undefined,
      undefined,
      "correction",
      "board.correction:v1_request",
      "agent-1",
    );

    expect(mockApi.post).toHaveBeenCalledWith("/issues/issue-1/comments", {
      body: "Check the source.",
      intent: "correction",
      idempotencyKey: "board.correction:v1_request",
      expectedAssigneeAgentId: "agent-1",
    });
  });
});

describe("issuesApi.addCommentAndReassign", () => {
  beforeEach(() => {
    mockApi.post.mockReset();
    mockApi.patch.mockReset();
  });

  it("posts a reassigned correction through the durable comment contract", async () => {
    mockApi.post.mockResolvedValue({
      id: "issue-1",
      assigneeAgentId: "agent-2",
      comment: { id: "comment-1", body: "Check the source." },
    });

    const result = await issuesApi.addCommentAndReassign(
      "issue-1",
      "Check the source.",
      { assigneeAgentId: "agent-2", assigneeUserId: null },
      {
        reopen: true,
        intent: "correction",
        idempotencyKey: "board.correction:v1_request",
        expectedAssigneeAgentId: "agent-2",
      },
    );

    expect(mockApi.post).toHaveBeenCalledWith("/issues/issue-1/comments", {
      body: "Check the source.",
      intent: "correction",
      idempotencyKey: "board.correction:v1_request",
      expectedAssigneeAgentId: "agent-2",
      reassignToAgentId: "agent-2",
      reopen: true,
    });
    expect(mockApi.patch).not.toHaveBeenCalled();
    expect(result.comment).toEqual({ id: "comment-1", body: "Check the source." });
  });

  it("retries a response-lost reassigned correction with the exact same single request", async () => {
    mockApi.post
      .mockRejectedValueOnce(new Error("Response lost"))
      .mockResolvedValueOnce({ id: "issue-1", comment: { id: "comment-1" } });
    const call = () => issuesApi.addCommentAndReassign(
      "issue-1",
      "Check the source.",
      { assigneeAgentId: "agent-2", assigneeUserId: null },
      {
        reopen: true,
        intent: "correction",
        idempotencyKey: "board.correction:v1_response-loss",
        expectedAssigneeAgentId: "agent-2",
      },
    );

    await expect(call()).rejects.toThrow("Response lost");
    await expect(call()).resolves.toMatchObject({ comment: { id: "comment-1" } });
    expect(mockApi.patch).not.toHaveBeenCalled();
    expect(mockApi.post).toHaveBeenCalledTimes(2);
    expect(mockApi.post.mock.calls[0]).toEqual(mockApi.post.mock.calls[1]);
  });

  it("fails closed when a reassigned correction also requests interruption", async () => {
    await expect(issuesApi.addCommentAndReassign(
      "issue-1",
      "Check the source.",
      { assigneeAgentId: "agent-2", assigneeUserId: null },
      {
        interrupt: true,
        intent: "correction",
        idempotencyKey: "board.correction:v1_interrupt",
        expectedAssigneeAgentId: "agent-2",
      },
    )).rejects.toThrow("Reassigned corrections cannot interrupt a run safely");
    expect(mockApi.patch).not.toHaveBeenCalled();
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it("keeps ordinary reassigned comments on the combined update request", async () => {
    mockApi.patch.mockResolvedValue({ id: "issue-1" });

    await issuesApi.addCommentAndReassign(
      "issue-1",
      "Please take this.",
      { assigneeAgentId: "agent-2", assigneeUserId: null },
    );

    expect(mockApi.patch).toHaveBeenCalledWith("/issues/issue-1", {
      comment: "Please take this.",
      assigneeAgentId: "agent-2",
      assigneeUserId: null,
    });
    expect(mockApi.post).not.toHaveBeenCalled();
  });
});
