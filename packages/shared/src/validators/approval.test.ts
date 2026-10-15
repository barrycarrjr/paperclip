import { describe, expect, it } from "vitest";
import {
  addApprovalCommentSchema,
  instructionChangePayloadSchema,
  requestApprovalRevisionSchema,
  resubmitApprovalSchema,
  resolveApprovalSchema,
} from "./approval.js";

describe("approval validators", () => {
  it("requires complete, strict instruction change payloads", () => {
    const payload = {
      version: 1,
      scope: "agent",
      targetAgentId: "11111111-1111-4111-8111-111111111111",
      sourceIssueId: "22222222-2222-4222-8222-222222222222",
      sourceCommentId: "33333333-3333-4333-8333-333333333333",
      rule: "Verify totals before posting them.",
    };
    expect(instructionChangePayloadSchema.safeParse(payload).success).toBe(true);
    expect(instructionChangePayloadSchema.safeParse({ ...payload, rule: "" }).success).toBe(false);
    expect(instructionChangePayloadSchema.safeParse({ ...payload, extra: true }).success).toBe(false);
  });
  it("passes real line breaks through unchanged", () => {
    expect(addApprovalCommentSchema.parse({ body: "Looks good\n\nApproved." }).body)
      .toBe("Looks good\n\nApproved.");
    expect(resolveApprovalSchema.parse({ decisionNote: "Decision\n\nApproved." }).decisionNote)
      .toBe("Decision\n\nApproved.");
  });

  it("accepts null and omitted optional decision notes", () => {
    expect(resolveApprovalSchema.parse({ decisionNote: null }).decisionNote).toBeNull();
    expect(resolveApprovalSchema.parse({}).decisionNote).toBeUndefined();
    expect(requestApprovalRevisionSchema.parse({ decisionNote: null }).decisionNote).toBeNull();
    expect(requestApprovalRevisionSchema.parse({}).decisionNote).toBeUndefined();
  });

  it("accepts a persisted revision cycle on approval resubmission", () => {
    expect(resubmitApprovalSchema.parse({
      revisionCycle: "2026-10-15T10:00:00.000Z",
      payload: { rule: "Revised rule" },
    })).toMatchObject({ revisionCycle: "2026-10-15T10:00:00.000Z" });
    expect(resubmitApprovalSchema.safeParse({ revisionCycle: "not-a-date" }).success).toBe(false);
  });

  it("normalizes escaped line breaks in approval comments and decision notes", () => {
    expect(addApprovalCommentSchema.parse({ body: "Looks good\\n\\nApproved." }).body)
      .toBe("Looks good\n\nApproved.");
    expect(resolveApprovalSchema.parse({ decisionNote: "Decision\\n\\nApproved." }).decisionNote)
      .toBe("Decision\n\nApproved.");
    expect(requestApprovalRevisionSchema.parse({ decisionNote: "Decision\\r\\nRevise." }).decisionNote)
      .toBe("Decision\nRevise.");
  });
});
