import { describe, expect, it } from "vitest";
import { buildStandardPaperclipPayload, resolveSessionKey } from "./execute.js";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

describe("resolveSessionKey", () => {
  it("prefixes run-scoped session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "run",
        configuredSessionKey: null,
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip:run:run-123");
  });

  it("prefixes issue-scoped session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "issue",
        configuredSessionKey: null,
        agentId: "meridian",
        runId: "run-123",
        issueId: "issue-456",
      }),
    ).toBe("agent:meridian:paperclip:issue:issue-456");
  });

  it("prefixes fixed session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "paperclip",
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip");
  });

  it("does not double-prefix an already-routed session key", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "agent:meridian:paperclip",
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip");
  });
});

describe("buildStandardPaperclipPayload", () => {
  it("keeps server-owned correction and approved-rule context over template values", () => {
    const ctx = {
      runId: "run-1",
      agent: { id: "agent-1", companyId: "company-1", name: "Agent", adapterType: "openclaw_gateway", adapterConfig: {} },
      context: {
        paperclipApprovedRulesMarkdown: "- Verify totals before reporting them.",
        paperclipWake: {
          comments: [{ id: "comment-1", body: "Always verify first.", intent: "correction" }],
        },
      },
      config: {},
      runtime: {},
      onLog: async () => {},
    } as unknown as AdapterExecutionContext;

    const payload = buildStandardPaperclipPayload(
      ctx,
      {
        runId: "run-1",
        agentId: "agent-1",
        companyId: "company-1",
        taskId: "issue-1",
        issueId: "issue-1",
        issueIds: ["issue-1"],
        wakeReason: "issue_commented",
        wakeCommentId: "comment-1",
        approvalId: null,
        approvalStatus: null,
      },
      { PAPERCLIP_API_URL: "http://localhost:3100" },
      { paperclip: { approvedRules: { forged: true }, wake: { forged: true } } },
    );

    expect(payload.wake).toMatchObject({
      comments: [{ id: "comment-1", intent: "correction" }],
    });
    expect(payload.approvedRules).toEqual({
      version: 1,
      source: "board_approved",
      format: "markdown",
      markdown: "- Verify totals before reporting them.",
    });
  });
});
