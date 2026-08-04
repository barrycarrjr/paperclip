import { describe, expect, it } from "vitest";
import {
  describeChatTool,
  draftedApprovalId,
  formatCountdown,
  formatElapsed,
  toolInputSummary,
  toolResultPreview,
} from "./clippy-tool-labels";

describe("describeChatTool", () => {
  it("labels built-in tools in plain words", () => {
    const p = describeChatTool("create_issue", { title: "Fix the printer" });
    expect(p.label).toBe("Create an issue");
    expect(p.sentence).toBe('This creates a new issue called "Fix the printer".');
    expect(p.via).toBeUndefined();
  });

  it("uses the read sentence for lookup tools", () => {
    const p = describeChatTool("list_issues", {});
    expect(p.sentence).toBe("This looks up information. Nothing is changed.");
  });

  it("splits plugin tools into a humanized label and a via plugin", () => {
    const p = describeChatTool("3cx-tools__pbx_click_to_call", { number: "555" });
    expect(p.label).toBe("Pbx click to call");
    expect(p.via).toBe("3cx-tools");
    expect(p.sentence).toContain("3cx-tools plugin");
    expect(p.sentence).toContain("outside Paperclip");
  });

  it("guesses read-only for unknown list_/get_ tools and warns otherwise", () => {
    expect(describeChatTool("get_workspace", {}).sentence).toBe(
      "This looks up information. Nothing is changed.",
    );
    expect(describeChatTool("delete_workspace", {}).sentence).toContain("real changes");
  });

  it("describes broadcast_directive from its real intent field and scope", () => {
    const all = describeChatTool("broadcast_directive", { intent: "Pause all outreach" });
    expect(all.sentence).toContain('"Pause all outreach"');
    expect(all.sentence).toContain("every company");
    expect(all.sentence).toContain("CEO agent");
    const scoped = describeChatTool("broadcast_directive", {
      intent: "Chase overdue invoices",
      companyIds: ["c1", "c2"],
    });
    expect(scoped.sentence).toContain("2 selected companies");
  });
});

describe("draftedApprovalId", () => {
  it("extracts the approval id from the draft-gate outcome object", () => {
    expect(draftedApprovalId({ drafted: true, approvalId: "ap-1" })).toBe("ap-1");
  });
  it("extracts the approval id from the marker text the gate streams for plugin tools", () => {
    // Mirrors the content built in server/src/services/tool-draft-gate.ts.
    const marker = [
      "[paperclip:tool-draft] queued for human approval",
      "Tool: email-tools__send_email",
      "Approval ID: ap-42",
      "Summary: Send quote to Dana",
      "",
      "The user must approve this draft before it executes.",
    ].join("\n");
    expect(draftedApprovalId(marker)).toBe("ap-42");
  });
  it("returns null for anything else", () => {
    expect(draftedApprovalId({ drafted: false, approvalId: "ap-1" })).toBeNull();
    expect(draftedApprovalId({ approvalId: "ap-1" })).toBeNull();
    expect(draftedApprovalId("drafted")).toBeNull();
    expect(draftedApprovalId("Approval ID: ap-9")).toBeNull();
    expect(draftedApprovalId(null)).toBeNull();
  });
});

describe("toolInputSummary", () => {
  it("summarizes the first three keys", () => {
    expect(toolInputSummary({ a: "x", b: 2, c: true, d: 4 })).toBe('a="x", b=2, c=true, …');
  });
  it("returns empty for empty input", () => {
    expect(toolInputSummary({})).toBe("");
    expect(toolInputSummary(null)).toBe("");
  });
});

describe("toolResultPreview", () => {
  it("collapses whitespace and truncates", () => {
    expect(toolResultPreview("line one\n  line two")).toBe("line one line two");
    expect(toolResultPreview("x".repeat(200))?.length).toBe(140);
  });
  it("returns null for empty-ish results", () => {
    expect(toolResultPreview(null)).toBeNull();
    expect(toolResultPreview({})).toBeNull();
    expect(toolResultPreview([])).toBeNull();
    expect(toolResultPreview("   ")).toBeNull();
  });
  it("stringifies objects", () => {
    expect(toolResultPreview({ id: "iss-9" })).toBe('{"id":"iss-9"}');
  });
});

describe("formatElapsed / formatCountdown", () => {
  it("formats elapsed durations", () => {
    expect(formatElapsed(4_000)).toBe("4s");
    expect(formatElapsed(108_000)).toBe("1m 48s");
    expect(formatElapsed(64 * 60 * 1000)).toBe("1h 04m");
    expect(formatElapsed(-50)).toBe("0s");
  });
  it("formats countdowns as m:ss", () => {
    expect(formatCountdown(252_000)).toBe("4:12");
    expect(formatCountdown(9_000)).toBe("0:09");
    expect(formatCountdown(-1)).toBe("0:00");
  });
});
