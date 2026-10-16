// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import {
  correctionDeliveryStorageKey,
  correctionRequestForBody,
  pendingCorrectionAfterError,
  readPendingCorrectionDeliveries,
  writePendingCorrectionDeliveries,
} from "./issue-comment-idempotency";

describe("saved correction deliveries", () => {
  const storageKey = correctionDeliveryStorageKey("company-1", "issue-1", "user-1");
  const delivery = {
    request: correctionRequestForBody(null, "issue-1", "Check the source.", "agent-1", () => "original"),
    commentId: "comment-1", reopen: true,
    pending: [{ agentId: "agent-1", reason: "Agent is paused" }],
  };

  beforeEach(() => window.localStorage.clear());

  it("restores exact retry data only in the original company, issue and author scope", () => {
    expect(writePendingCorrectionDeliveries(storageKey, [delivery])).toBeNull();
    expect(readPendingCorrectionDeliveries(storageKey, "issue-1")).toEqual({ deliveries: [delivery], storageError: null });
    for (const key of [
      correctionDeliveryStorageKey("company-2", "issue-1", "user-1"),
      correctionDeliveryStorageKey("company-1", "issue-2", "user-1"),
      correctionDeliveryStorageKey("company-1", "issue-1", "user-2"),
    ]) expect(readPendingCorrectionDeliveries(key, "issue-1").deliveries).toEqual([]);
  });

  it("restores a request saved before the server response is known", () => {
    const unconfirmed = { request: delivery.request, reopen: true, pending: delivery.pending };
    expect(writePendingCorrectionDeliveries(storageKey, [unconfirmed])).toBeNull();
    expect(readPendingCorrectionDeliveries(storageKey, "issue-1")).toEqual({
      deliveries: [unconfirmed],
      storageError: null,
    });
  });

  it.each([
    "invalid JSON", "null", "[null]",
    JSON.stringify([{ ...delivery, request: { ...delivery.request, issueId: "issue-2" } }]),
    JSON.stringify([{ ...delivery, request: { ...delivery.request, targetSelectionKey: "reassign:agent-2" } }]),
    JSON.stringify([{ ...delivery, pending: [null] }]),
  ])("reports unreadable data and does not offer an unsafe retry: %s", (raw) => {
    window.localStorage.setItem(storageKey, raw);
    const result = readPendingCorrectionDeliveries(storageKey, "issue-1");
    expect(result.deliveries).toEqual([]);
    expect(result.storageError).toContain("Saved correction retries could not be read");
    expect(window.localStorage.getItem(storageKey)).toBe(raw);
  });
});

describe("correctionRequestForBody", () => {
  it("reuses the request key when the same correction is retried", () => {
    const first = correctionRequestForBody(null, "issue-1", "Check the source.", "agent-1", () => "first");
    const retry = correctionRequestForBody(first, "issue-1", "Check the source.", "agent-2", () => "second");

    expect(retry).toBe(first);
    expect(retry.idempotencyKey).toBe("board.correction:v1_first");
    expect(retry.expectedAssigneeAgentId).toBe("agent-1");
  });

  it("reuses a pending correction after a server failure and refetch removes the assignee", () => {
    const first = correctionRequestForBody(null, "issue-1", "Check the source.", "agent-1", () => "first");
    const pending = pendingCorrectionAfterError(first, new ApiError("Wake delivery failed", 500));
    const retry = correctionRequestForBody(pending, "issue-1", "Check the source.", null, () => "second");
    expect(retry).toBe(first);
    expect(retry.expectedAssigneeAgentId).toBe("agent-1");
  });

  it("requires an assigned agent for new corrections, including edited pending drafts", () => {
    expect(() => correctionRequestForBody(null, "issue-1", "Check the source.", null)).toThrow("Correction comments require an assigned agent.");
    const pending = correctionRequestForBody(null, "issue-1", "Check the source.", "agent-1", () => "first");
    expect(() => correctionRequestForBody(pending, "issue-1", "Check the total.", null)).toThrow("Correction comments require an assigned agent.");
    expect(() => correctionRequestForBody(pending, "issue-2", "Check the source.", null)).toThrow("Correction comments require an assigned agent.");
  });

  it("creates a new request key when the correction body changes", () => {
    const first = correctionRequestForBody(null, "issue-1", "Check the source.", "agent-1", () => "first");
    const changed = correctionRequestForBody(first, "issue-1", "Check the total.", "agent-2", () => "second");

    expect(changed).toEqual({
      issueId: "issue-1",
      body: "Check the total.",
      idempotencyKey: "board.correction:v1_second",
      expectedAssigneeAgentId: "agent-2",
      targetSelectionKey: "current-assignee",
    });
  });

  it("creates a new request when the same body is submitted on another issue", () => {
    const first = correctionRequestForBody(null, "issue-1", "Check the source.", "agent-1", () => "first");
    const otherIssue = correctionRequestForBody(first, "issue-2", "Check the source.", "agent-2", () => "second");

    expect(otherIssue).toEqual({
      issueId: "issue-2",
      body: "Check the source.",
      idempotencyKey: "board.correction:v1_second",
      expectedAssigneeAgentId: "agent-2",
      targetSelectionKey: "current-assignee",
    });
  });

  it("keeps a reassigned correction stable across retries for the same selected agent", () => {
    const first = correctionRequestForBody(
      null,
      "issue-1",
      "Check the source.",
      "agent-2",
      () => "first",
      "reassign:agent-2",
    );
    const retry = correctionRequestForBody(
      first,
      "issue-1",
      "Check the source.",
      "agent-2",
      () => "second",
      "reassign:agent-2",
    );

    expect(retry).toBe(first);
  });

  it("creates a new correction request when the selected reassignment target changes", () => {
    const first = correctionRequestForBody(
      null,
      "issue-1",
      "Check the source.",
      "agent-2",
      () => "first",
      "reassign:agent-2",
    );
    const changed = correctionRequestForBody(
      first,
      "issue-1",
      "Check the source.",
      "agent-3",
      () => "second",
      "reassign:agent-3",
    );

    expect(changed.idempotencyKey).toBe("board.correction:v1_second");
    expect(changed.expectedAssigneeAgentId).toBe("agent-3");
  });
});

describe("pendingCorrectionAfterError", () => {
  const pending = correctionRequestForBody(
    null,
    "issue-1",
    "Check the source.",
    "agent-1",
    () => "first",
  );

  it("discards the stale target after a pre-insert assignee race", () => {
    const conflict = new ApiError(
      "The correction is no longer assigned to the expected agent",
      409,
      { code: "correction_assignee_conflict" },
    );

    expect(pendingCorrectionAfterError(pending, conflict)).toBeNull();
  });

  it("keeps the request identity when the response is ambiguous", () => {
    expect(pendingCorrectionAfterError(pending, new ApiError("Paperclip is not answering", 0))).toBe(pending);
    expect(pendingCorrectionAfterError(pending, new ApiError("Conflict", 409, {
      code: "issue_comment_idempotency_conflict",
    }))).toBe(pending);
  });
});
