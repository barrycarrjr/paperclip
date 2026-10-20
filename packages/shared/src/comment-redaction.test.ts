import { describe, expect, it } from "vitest";
import { applyCommentRedactions, commentRedactionReplacement, commentRedactionRanges, redactIssueCommentSchema } from "./comment-redaction.js";

describe("comment redaction", () => {
  it("keeps the last 4 by default, or hides everything", () => {
    expect(commentRedactionReplacement("9000-0012-3456")).toBe("[redacted …3456]");
    expect(commentRedactionReplacement("9000001234", false)).toBe("[redacted]");
    expect(commentRedactionReplacement("1234")).toBe("[redacted]");
  });

  it("fully hides selections with at most eight letters or digits, including short labelled secrets", () => {
    for (const target of ["1234", "12345", "123456", "PIN 4821", "CVV 123", "12345678", "一二三四五六七八", "🚀12345678"]) {
      expect(commentRedactionReplacement(target)).toBe("[redacted]");
      expect(commentRedactionReplacement(target, false)).toBe("[redacted]");
    }
    for (const [target, suffix] of [["123456789", "6789"], ["一二三四五六七八九", "六七八九"], ["🚀12345-6789", "6789"]]) {
      expect(commentRedactionReplacement(target!)).toBe(`[redacted …${suffix}]`);
      expect(commentRedactionReplacement(target!, false)).toBe("[redacted]");
      expect(applyCommentRedactions(target!, [target!]).text).toBe(commentRedactionReplacement(target!));
    }
  });

  it("rejects unpaired surrogate targets while retaining valid emoji and UTF-16 ranges", () => {
    for (const target of ["abc\ud800", "abc\udc00", "\udc00abcd", "abcd\ud800x"]) {
      expect(redactIssueCommentSchema.safeParse({ targets: [target], expectedBody: "synthetic" }).success).toBe(false);
    }
    const target = "🚀🚀🚀🚀";
    expect(redactIssueCommentSchema.safeParse({ targets: [target], expectedBody: target }).success).toBe(true);
    expect(applyCommentRedactions("a" + target + "b", [target]).text).toBe("a[redacted]b");
    expect(commentRedactionRanges("a" + target + "b", [target])).toEqual([{ start: 1, length: 8 }]);
    expect(redactIssueCommentSchema.safeParse({ targets: ["🚀🚀"], expectedBody: "synthetic" }).success).toBe(false);
  });

  it("replaces every occurrence, longest target first", () => {
    const r = applyCommentRedactions("Acct 9000001234 and 9000001234-77; ref 0012", ["9000001234", "9000001234-77"]);
    expect(r.text).toBe("Acct [redacted …1234] and [redacted …3477]; ref 0012");
    expect(r.replaced).toBe(2);
  });

  it("preserves exact text, Unicode, quotes, backslashes, whitespace and newlines", () => {
    const target = ' Example "private"\\value\n第二行 ';
    expect(redactIssueCommentSchema.parse({ targets: [target], expectedBody: target })).toEqual({ targets: [target], keepLast4: true, expectedBody: target });
    expect(applyCommentRedactions(`Start${target}End`, [target], false).text).toBe("Start[redacted]End");
    expect(redactIssueCommentSchema.safeParse({ targets: [" "], expectedBody: " " }).success).toBe(false);
    expect(redactIssueCommentSchema.safeParse({ targets: [], expectedBody: "test" }).success).toBe(false);
    expect(redactIssueCommentSchema.safeParse({ targets: ["test"] }).success).toBe(false);
  });

  it("accepts short PINs but requires surrounding text for shorter secrets", () => {
    expect(redactIssueCommentSchema.safeParse({ targets: ["1234"], expectedBody: "1234" }).success).toBe(true);
    for (const target of ["x", "12", "pin", "   a"]) expect(redactIssueCommentSchema.safeParse({ targets: [target], expectedBody: target }).success).toBe(false);
  });

  it("does not redact its own generated replacement or treat targets as patterns", () => {
    expect(applyCommentRedactions("example-123456", ["example-123456", "redacted", "3456"])).toEqual({ text: "[redacted …3456]", replaced: 1 });
    expect(applyCommentRedactions("x.* xab", ["x.*"], false)).toEqual({ text: "[redacted] xab", replaced: 1 });
    expect(applyCommentRedactions(" value  value", [" value "], false).text).toBe("[redacted] value");
  });
});

it("accepts million-character comments but enforces a byte-sized body limit", () => {
  const base = { targets: ["synthetic"], expectedBody: "x".repeat(1_000_500) };
  expect(redactIssueCommentSchema.safeParse(base).success).toBe(true);
  const oversized = redactIssueCommentSchema.safeParse({ ...base, expectedBody: "\u00e9".repeat(16 * 1024 * 1024) });
  expect(oversized.success).toBe(false);
  if (!oversized.success) expect(oversized.error.issues.some((issue) => issue.path[0] === "expectedBody" && issue.message.includes("30 MiB UTF-8"))).toBe(true);
});
