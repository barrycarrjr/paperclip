import { describe, expect, it } from "vitest";
import {
  addIssueCommentSchema,
  createIssueSchema,
  respondIssueThreadInteractionSchema,
  suggestedTaskDraftSchema,
  updateIssueSchema,
  upsertIssueDocumentSchema,
} from "./issue.js";

describe("issue validators", () => {
  it("passes real line breaks through unchanged", () => {
    const parsed = createIssueSchema.parse({
      title: "Follow up PR",
      description: "Line 1\n\nLine 2",
    });

    expect(parsed.description).toBe("Line 1\n\nLine 2");
  });

  it("accepts null and omitted optional multiline issue fields", () => {
    expect(createIssueSchema.parse({ title: "Follow up PR", description: null }).description)
      .toBeNull();
    expect(createIssueSchema.parse({ title: "Follow up PR" }).description)
      .toBeUndefined();
    expect(updateIssueSchema.parse({ comment: undefined }).comment)
      .toBeUndefined();
  });

  it("normalizes JSON-escaped line breaks in issue descriptions", () => {
    const parsed = createIssueSchema.parse({
      title: "Follow up PR",
      description: "PR: https://example.com/pr/1\\n\\nShip the follow-up.",
    });

    expect(parsed.description).toBe("PR: https://example.com/pr/1\n\nShip the follow-up.");
  });

  it("normalizes escaped line breaks in issue update comments", () => {
    const parsed = updateIssueSchema.parse({
      comment: "Done\\n\\n- Verified the route",
    });

    expect(parsed.comment).toBe("Done\n\n- Verified the route");
  });

  it("normalizes escaped line breaks in issue comment bodies", () => {
    const parsed = addIssueCommentSchema.parse({
      body: "Progress update\\r\\n\\r\\nNext action.",
    });

    expect(parsed.body).toBe("Progress update\n\nNext action.");
  });

  it("normalizes escaped line breaks in generated task drafts", () => {
    const parsed = suggestedTaskDraftSchema.parse({
      clientKey: "task-1",
      title: "Follow up",
      description: "Line 1\\n\\nLine 2",
    });

    expect(parsed.description).toBe("Line 1\n\nLine 2");
  });

  it("normalizes escaped line breaks in thread summaries and documents", () => {
    const response = respondIssueThreadInteractionSchema.parse({
      answers: [],
      summaryMarkdown: "Summary\\n\\nNext action",
    });
    const document = upsertIssueDocumentSchema.parse({
      format: "markdown",
      body: "# Plan\\n\\nShip it",
    });

    expect(response.summaryMarkdown).toBe("Summary\n\nNext action");
    expect(document.body).toBe("# Plan\n\nShip it");
  });

  describe("client-declarable issue origin (P5a)", () => {
    it("accepts an email handoff origin", () => {
      const parsed = createIssueSchema.parse({
        title: "Email from a@b.com: Invoice",
        origin: { kind: "email_handoff", id: "email:v1:msgid:p1:personal:%3Cm1%3E" },
      });

      expect(parsed.origin).toEqual({
        kind: "email_handoff",
        id: "email:v1:msgid:p1:personal:%3Cm1%3E",
      });
    });

    // The point of the literal: origin kinds drive real partial unique indexes
    // and recovery classification, so a client must not be able to claim one.
    it("rejects every reserved, server-set origin kind", () => {
      for (const kind of [
        "routine_execution",
        "harness_liveness_escalation",
        "stranded_issue_recovery",
        "stale_active_run_evaluation",
        "manual",
        "plugin:anything",
      ]) {
        expect(
          () => createIssueSchema.parse({ title: "x", origin: { kind, id: "whatever" } }),
          kind,
        ).toThrow();
      }
    });

    it("rejects a malformed origin rather than storing a useless reference", () => {
      expect(() =>
        createIssueSchema.parse({ title: "x", origin: { kind: "email_handoff", id: "" } }),
      ).toThrow();
      expect(() =>
        createIssueSchema.parse({ title: "x", origin: { kind: "email_handoff" } }),
      ).toThrow();
    });

    it("stays optional, so ordinary issue creation is unaffected", () => {
      expect(createIssueSchema.parse({ title: "x" }).origin).toBeUndefined();
    });
  });
});
