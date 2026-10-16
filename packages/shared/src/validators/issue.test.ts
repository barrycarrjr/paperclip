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
  it("accepts correction intent and defaults ordinary comments to message", () => {
    expect(addIssueCommentSchema.parse({ body: "Please do this differently" }).intent).toBe("message");
    expect(addIssueCommentSchema.parse({
      body: "Please do this differently",
      intent: "correction",
      idempotencyKey: "board.correction:v1_test",
    }).intent)
      .toBe("correction");
    expect(() => addIssueCommentSchema.parse({
      body: "Please do this differently",
      intent: "correction",
    })).toThrow("Correction comments require an idempotency key");
  });
  it("accepts an expected assignee only for correction comments", () => {
    const expectedAssigneeAgentId = "22222222-2222-4222-8222-222222222222";
    expect(addIssueCommentSchema.parse({
      body: "Please do this differently",
      intent: "correction",
      expectedAssigneeAgentId,
      idempotencyKey: "board.correction:v1_expected-agent",
    }).expectedAssigneeAgentId).toBe(expectedAssigneeAgentId);
    expect(() => addIssueCommentSchema.parse({
      body: "Ordinary comment",
      expectedAssigneeAgentId,
    })).toThrow("An expected assignee can only be supplied for correction comments");
    expect(() => addIssueCommentSchema.parse({
      body: "Correction",
      intent: "correction",
      expectedAssigneeAgentId: "not-an-agent-id",
      idempotencyKey: "board.correction:v1_invalid-agent",
    })).toThrow();
  });
  it("accepts prior assignee targeting only for an explicit correction target", () => {
    expect(addIssueCommentSchema.parse({
      body: "Revise the earlier run.",
      intent: "correction",
      expectedAssigneeAgentId: "22222222-2222-4222-8222-222222222222",
      allowPriorAssigneeTarget: true,
      idempotencyKey: "handoff.review:v1_prior-agent",
    }).allowPriorAssigneeTarget).toBe(true);
    expect(() => addIssueCommentSchema.parse({
      body: "Revise the earlier run.",
      intent: "correction",
      allowPriorAssigneeTarget: true,
      idempotencyKey: "handoff.review:v1_missing-agent",
    })).toThrow("A prior assignee target requires a correction with an expected assignee");
  });
  it("accepts bounded portable issue-comment idempotency keys", () => {
    expect(addIssueCommentSchema.parse({ body: "Reply", idempotencyKey: "ollama.mixed:v1_key-123" }).idempotencyKey)
      .toBe("ollama.mixed:v1_key-123");
    expect(() => addIssueCommentSchema.parse({ body: "Reply", idempotencyKey: "not allowed" })).toThrow();
    expect(() => addIssueCommentSchema.parse({ body: "Reply", idempotencyKey: "x".repeat(201) })).toThrow();
  });
  it("keeps idempotent comment creation separate from issue and run state changes", () => {
    for (const stateChange of ["reopen", "resume", "interrupt"] as const) {
      expect(() => addIssueCommentSchema.parse({
        body: "Reply once",
        idempotencyKey: "ollama.mixed:v1_key-123",
        [stateChange]: true,
      })).toThrow("Idempotent comment creation cannot be combined with issue or run state changes");
    }
  });
  it.each([undefined, "22222222-2222-4222-8222-222222222222"])(
    "allows idempotent correction reopening with expected assignee %s without reassignment",
    (expectedAssigneeAgentId) => {
      expect(addIssueCommentSchema.parse({
        body: "Check the source.",
        intent: "correction",
        idempotencyKey: "board.correction:v1_reopen",
        expectedAssigneeAgentId,
        reopen: true,
      })).toMatchObject({ intent: "correction", reopen: true });
    },
  );
  it.each(["resume", "interrupt"] as const)(
    "rejects idempotent correction %s even when reopening",
    (stateChange) => {
      for (const reopen of [undefined, true]) {
        expect(() => addIssueCommentSchema.parse({
          body: "Check the source.",
          intent: "correction",
          idempotencyKey: "board.correction:v1_run-state",
          reopen,
          [stateChange]: true,
        })).toThrow("Idempotent comment creation cannot be combined with issue or run state changes");
      }
    },
  );
  it("allows reopening with an atomic correction reassignment and validates its target", () => {
    const targetAgentId = "22222222-2222-4222-8222-222222222222";
    expect(addIssueCommentSchema.parse({
      body: "Check the source.",
      intent: "correction",
      idempotencyKey: "board.correction:v1_reassign",
      expectedAssigneeAgentId: targetAgentId,
      reassignToAgentId: targetAgentId,
      reopen: true,
    })).toMatchObject({ reassignToAgentId: targetAgentId, reopen: true });
    expect(() => addIssueCommentSchema.parse({
      body: "Check the source.",
      intent: "correction",
      idempotencyKey: "board.correction:v1_wrong-target",
      expectedAssigneeAgentId: targetAgentId,
      reassignToAgentId: "33333333-3333-4333-8333-333333333333",
    })).toThrow("A correction reassignment must match the expected correction target");
    expect(() => addIssueCommentSchema.parse({
      body: "Check the source.",
      intent: "correction",
      idempotencyKey: "board.correction:v1_interrupt",
      expectedAssigneeAgentId: targetAgentId,
      reassignToAgentId: targetAgentId,
      interrupt: true,
    })).toThrow("Atomic correction reassignment does not support run interruption or resume intent");
  });
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

  it("rejects correction comments in issue updates", () => {
    expect(updateIssueSchema.parse({
      comment: "Ordinary progress update",
      commentIntent: "message",
    }).commentIntent).toBe("message");
    expect(() => updateIssueSchema.parse({
      comment: "Please correct the earlier run",
      commentIntent: "correction",
    })).toThrow("Correction comments must be submitted with POST /issues/:id/comments");
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
