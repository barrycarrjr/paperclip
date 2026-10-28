import { describe, expect, it } from "vitest";
import {
  approvalLabel,
  approvalSubject,
  humanizeToolName,
  outboundToolLabel,
  summarizeParameters,
} from "./approval-labels.js";

describe("humanizeToolName", () => {
  it("converts snake_case tool name to Title case words", () => {
    expect(humanizeToolName("email_mark_read")).toBe("Email mark read");
    expect(humanizeToolName("some_custom_action")).toBe("Some custom action");
    expect(humanizeToolName("plugin:do_something_cool")).toBe("Do something cool");
  });
});

describe("outboundToolLabel", () => {
  it("returns mapped human label for known tools", () => {
    expect(outboundToolLabel("email-tools:email_send")).toBe("Email");
    expect(outboundToolLabel("email-tools:email_mark_read")).toBe("Mark email read");
    expect(outboundToolLabel("email-tools:email_mark_unread")).toBe("Mark email unread");
    expect(outboundToolLabel("email-tools:email_move")).toBe("Move email");
    expect(outboundToolLabel("google-workspace:gcal_create_event")).toBe("Create calendar event");
  });

  it("humanizes unknown tools", () => {
    expect(outboundToolLabel("custom-tools:custom_query")).toBe("Custom query");
  });

  it("handles null and undefined", () => {
    expect(outboundToolLabel(null)).toBe("Outbound action");
    expect(outboundToolLabel(undefined)).toBe("Outbound action");
  });
});

describe("summarizeParameters", () => {
  it("formats mailbox and uid for email operations", () => {
    expect(summarizeParameters({ mailbox: "m3-barry", uid: "280179" })).toBe(
      "mailbox m3-barry, UID 280179",
    );
  });

  it("formats title, subject, or name when present", () => {
    expect(summarizeParameters({ title: "Quarterly Review" })).toBe("Quarterly Review");
    expect(summarizeParameters({ subject: "Invoice #1024" })).toBe("Invoice #1024");
    expect(summarizeParameters({ name: "support-channel" })).toBe("support-channel");
  });

  it("formats target path, query, or channel", () => {
    expect(summarizeParameters({ channel: "#general" })).toBe("#general");
    expect(summarizeParameters({ filePath: "src/index.ts" })).toBe("src/index.ts");
    expect(summarizeParameters({ query: "SELECT * FROM users" })).toBe("SELECT * FROM users");
  });

  it("formats key-value entries when other fields are absent", () => {
    expect(summarizeParameters({ amount: 50, currency: "USD" })).toBe("amount: 50, currency: USD");
  });
});

describe("approvalLabel", () => {
  it("does not repeat the tool name when summary is identical to toolName", () => {
    const label = approvalLabel("outbound_tool_draft", {
      toolName: "email-tools:email_mark_read",
      summary: "email-tools:email_mark_read",
      parameters: { mailbox: "m3-barry", uid: "280179" },
    });
    expect(label).toBe("Mark email read: mailbox m3-barry, UID 280179");
    expect(label).not.toContain("email_mark_read: email-tools:email_mark_read");
  });

  it("falls back to parameters summary when summary is missing or empty", () => {
    const label = approvalLabel("outbound_tool_draft", {
      toolName: "email-tools:email_mark_read",
      parameters: { mailbox: "m3-barry", uid: "280179" },
    });
    expect(label).toBe("Mark email read: mailbox m3-barry, UID 280179");
  });

  it("returns clean verb when parameters cannot be summarized", () => {
    const label = approvalLabel("outbound_tool_draft", {
      toolName: "email-tools:email_mark_read",
      parameters: {},
    });
    expect(label).toBe("Mark email read");
  });

  it("retains meaningful summaries that differ from toolName", () => {
    const label = approvalLabel("outbound_tool_draft", {
      toolName: "email-tools:email_send",
      summary: 'to john@example.com "Project Update"',
    });
    expect(label).toBe('Email: to john@example.com "Project Update"');
  });

  it("formats board approval, hire agent, and instruction change correctly", () => {
    expect(
      approvalLabel("request_board_approval", {
        title: "Reply with an ASCII frog",
      }),
    ).toBe("Board Approval: Reply with an ASCII frog");

    expect(
      approvalLabel("hire_agent", {
        name: "DevOps Engineer",
      }),
    ).toBe("Hire Agent: DevOps Engineer");

    expect(
      approvalLabel("instruction_change", {
        rule: "Always check tests before shipping.",
      }),
    ).toBe("Instruction Rule: Always check tests before shipping.");
  });
});
