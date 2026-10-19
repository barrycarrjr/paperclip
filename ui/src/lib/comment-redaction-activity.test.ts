import { commentRedactionResultToast } from "./comment-redaction-result";
import type { CommentRedactionResponse } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { formatActivityVerb, formatIssueActivityAction } from "./activity-format";
import { isOutcomeAction } from "./outcomes";

describe("manual redaction activity", () => {
  it("makes incomplete delegated cleanup visible in both activity views", () => {
    const details = { fileCleanup: "complete", cleanupStatus: "incomplete", activeRunCount: 1 };
    expect(formatActivityVerb("issue.comment_redacted", details)).toContain("cleanup incomplete");
    expect(formatIssueActivityAction("issue.comment_redacted", details)).toContain("cleanup incomplete");
    expect(formatIssueActivityAction("issue.comment_redacted", { fileCleanup: "pending" })).toContain("audit pending");
    expect(formatIssueActivityAction("issue.comment_redacted", { fileCleanup: "complete", cleanupStatus: "complete" })).toContain("covered cleanup complete");
  });
  it("keeps both administrative redaction actions out of outcomes", () => {
    expect(isOutcomeAction("issue.comment_redacted")).toBe(false);
    expect(isOutcomeAction("issue.comment_redaction_authorized")).toBe(false);
  });
  it("uses a warning and the actual visible result without inventing active or size problems", () => {
    const result = { replaced: 1, placesChanged: { comment: 1, runLogFiles: 1, activityLog: 1 }, otherCommentsWithText: 0,
      fileCleanup: "complete", cleanupStatus: "incomplete", activeRunCount: 0, residualMatches: 0, cutoffCheckComplete: true, oversizedFields: 0, skippedFields: 0, auditFinalized: true } as CommentRedactionResponse;
    const toast = commentRedactionResultToast(result);
    expect(toast.tone).toBe("warn");
    expect(toast.body).toContain("2 stored copies cleaned");
    expect(toast.body).toContain("other users' private chats cannot be confirmed");
    expect(toast.body).toContain("cut-off copies may retain part");
    expect(toast.body).not.toMatch(/active run|oversized|deeply nested|pending|files were skipped/);
    const partial = commentRedactionResultToast({ ...result, cutoffCheckComplete: false, residualMatches: 3, activeRunCount: 2, oversizedFields: 1, skippedFields: 4, fileCleanup: "incomplete", auditFinalized: false });
    expect(partial.tone).toBe("warn");
    for (const detail of ["3 remaining matches", "2 active runs", "1 oversized field", "4 deeply nested fields", "Some run log files", "Audit finalization is still pending", "cut-off copy check did not finish"]) expect(partial.body).toContain(detail);
    const action = formatIssueActivityAction("issue.comment_redacted", { cutoffCheckComplete: false, residualMatches: 3, activeRunCount: 2, skippedFields: 4 });
    for (const detail of ["3 remaining matches", "2 active runs", "4 deeply nested fields", "private chats cannot be confirmed", "cut-off copy check did not finish"]) expect(action).toContain(detail);
    expect(commentRedactionResultToast({ ...result, activeRunCount: null }).body).toContain("Active run count could not be checked");
  });

});
