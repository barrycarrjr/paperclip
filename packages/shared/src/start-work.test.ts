import { describe, expect, it } from "vitest";
import { ISSUE_ORIGIN_KINDS } from "./constants.js";
import {
  MAX_START_WORK_TASKS,
  START_WORK_ORIGIN_KIND,
  isStartWorkOriginKind,
  startWorkInteractionIdempotencyKey,
} from "./start-work.js";
import { clientDeclarableIssueOriginSchema } from "./validators/issue.js";

describe("START_WORK_ORIGIN_KIND", () => {
  it("is not in ISSUE_ORIGIN_KINDS and is not client-declarable (clientDeclarableIssueOriginSchema rejects it)", () => {
    expect(START_WORK_ORIGIN_KIND).toBe("start_work");
    // Deliberately absent from the shared list: it follows the email_handoff
    // pattern of a feature-local kind that only the server can set.
    expect((ISSUE_ORIGIN_KINDS as readonly string[]).includes(START_WORK_ORIGIN_KIND)).toBe(false);
    // A browser cannot mint a request container by declaring the kind on a
    // normal create; only the plan route sets it.
    const parsed = clientDeclarableIssueOriginSchema.safeParse({
      kind: START_WORK_ORIGIN_KIND,
      id: "0c2b1f5e-8a0c-4b1a-9f4c-3c7d1c1c9f55",
    });
    expect(parsed.success).toBe(false);
  });

  it("isStartWorkOriginKind matches only the exact kind", () => {
    expect(isStartWorkOriginKind("start_work")).toBe(true);
    expect(isStartWorkOriginKind("email_handoff")).toBe(false);
    expect(isStartWorkOriginKind(null)).toBe(false);
    expect(isStartWorkOriginKind(undefined)).toBe(false);
  });
});

describe("startWorkInteractionIdempotencyKey", () => {
  it("idempotency key is start-work:<requestKey>", () => {
    const requestKey = "0c2b1f5e-8a0c-4b1a-9f4c-3c7d1c1c9f55";
    expect(startWorkInteractionIdempotencyKey(requestKey)).toBe(`start-work:${requestKey}`);
  });
});

describe("MAX_START_WORK_TASKS", () => {
  it("caps a plan at twelve tasks", () => {
    expect(MAX_START_WORK_TASKS).toBe(12);
  });
});
