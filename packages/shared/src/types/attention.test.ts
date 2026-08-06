import { describe, expect, it } from "vitest";
import { attentionRowIssueId, type AttentionRow } from "./attention.js";

function row(overrides: Partial<AttentionRow> = {}): AttentionRow {
  return {
    key: "question:iss-1",
    kind: "question",
    companyId: "c-1",
    title: "Which supplier?",
    detail: null,
    askedBy: null,
    blocking: "waiting",
    blockedSinceMs: 0,
    count: 1,
    consequence: null,
    href: "/issues/PAP-1",
    createdAtMs: 0,
    updatedAtMs: 0,
    ...overrides,
  };
}

describe("attentionRowIssueId", () => {
  it("reads the issue out of a question or sign-off key", () => {
    expect(attentionRowIssueId(row())).toBe("iss-1");
    expect(attentionRowIssueId(row({ kind: "sign_off", key: "sign_off:iss-9" }))).toBe("iss-9");
  });

  it("is silent for kinds that are not about an issue", () => {
    // An approval id is not an issue id, so a surface listing issues must not
    // treat it as one and hide an unrelated row.
    expect(attentionRowIssueId(row({ kind: "approval", key: "approval:appr-1" }))).toBeNull();
    expect(attentionRowIssueId(row({ kind: "budget_stop", key: "budget:inc-1" }))).toBeNull();
  });

  it("is silent on a malformed key rather than guessing", () => {
    expect(attentionRowIssueId(row({ key: "question" }))).toBeNull();
    expect(attentionRowIssueId(row({ key: "question:" }))).toBeNull();
  });
});
