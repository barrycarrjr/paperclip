import { describe, expect, it } from "vitest";
import { applyCommentRedactions, commentRedactionReplacement, redactIssueCommentSchema } from "./comment-redaction.js";

describe("comment redaction", () => {
  it("keeps the last 4 by default, or hides everything", () => {
    expect(commentRedactionReplacement("9000-0012-3456")).toBe("[redacted …3456]");
    expect(commentRedactionReplacement("9000001234", false)).toBe("[redacted]");
    expect(commentRedactionReplacement("1234")).toBe("[redacted]");
  });

  it("replaces every occurrence, longest target first", () => {
    const r = applyCommentRedactions("Acct 9000001234 and 9000001234-77; ref 0012", ["9000001234", "9000001234-77"]);
    expect(r.text).toBe("Acct [redacted …1234] and [redacted …3477]; ref 0012");
    expect(r.replaced).toBe(2);
  });

  it("accepts only plain targets of 4 to 200 characters", () => {
    expect(redactIssueCommentSchema.parse({ targets: [" 9000001234 "] })).toEqual({ targets: ["9000001234"], keepLast4: true });
    expect(redactIssueCommentSchema.safeParse({ targets: ["123"] }).success).toBe(false);
    expect(redactIssueCommentSchema.safeParse({ targets: ['90"01'] }).success).toBe(false);
    expect(redactIssueCommentSchema.safeParse({ targets: [] }).success).toBe(false);
  });
});
