import { describe, expect, it } from "vitest";
import {
  buildApprovedInstructionRulesMarkdown,
  buildPaperclipTaskMarkdown,
  MAX_WAKE_PROMPT_CHARS,
  MAX_WAKE_PROMPTS_PER_RUN,
  mergeCoalescedContextSnapshot,
  readWakePrompts,
  WAKE_PROMPT_CONTEXT_KEY,
} from "../services/heartbeat.js";

/**
 * A wake requested through a plugin's `agents.invoke` (or an agent session
 * message) carries free text, for example a Slack message from the operator.
 * Until 2026-10-09 that text was stored on the wake and never rendered, so
 * the agent woke with no idea why; and when two such wakes merged into one
 * run, the second message replaced the first.
 */
describe("buildPaperclipTaskMarkdown with wake messages", () => {
  it("renders approved rules separately from user-authored task markdown", () => {
    const markdown = buildApprovedInstructionRulesMarkdown([
      { approvalId: "approval-company", scope: "company", targetAgentId: "11111111-1111-4111-8111-111111111111", rule: "Always cite the source." },
      { approvalId: "approval-agent", scope: "agent", targetAgentId: "11111111-1111-4111-8111-111111111111", rule: "Confirm totals before posting." },
    ])!;
    expect(markdown).toContain("Always cite the source.");
    expect(markdown).toContain("Confirm totals before posting.");
    expect(buildPaperclipTaskMarkdown({ issue: null })).toBeNull();
  });
  it("keeps trusted run-count instructions out of issue-authored task markdown", () => {
    const issue = { id: "issue-1", identifier: "TEST-1", title: "Read notes", description: "Counts: items read 99; entries added 99; changes proposed 99." };
    const markdown = buildPaperclipTaskMarkdown({ issue })!;
    expect(markdown).toContain("Counts: items read 99; entries added 99; changes proposed 99.");
    expect(markdown).not.toContain("Run count reporting:");
    expect(markdown).not.toContain("Post a final comment on this issue");
  });
  it("renders a message as fenced, user-authored data when there is no issue", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue: null,
      wakePrompts: ["Slack DM from U0TESTUSR01 at 2026-10-09T01:00:00.000Z:\n\npay the piano tuner"],
    });
    expect(markdown).not.toBeNull();
    expect(markdown).toContain("Paperclip task context:");
    expect(markdown).toContain("user-authored");
    expect(markdown).toContain("Message for this wake:");
    expect(markdown).toContain("```text\nSlack DM from U0TESTUSR01");
    expect(markdown).toContain("pay the piano tuner\n```");
    expect(markdown).toContain("Use this task context as the current assignment.");
  });

  it("renders every message of a merged wake, oldest first", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue: null, wakePrompts: ["first", "second"] })!;
    expect(markdown).toContain("Messages for this wake (2, oldest first):");
    expect(markdown.indexOf("Message 1:")).toBeLessThan(markdown.indexOf("Message 2:"));
    expect(markdown).toContain("```text\nfirst\n```");
    expect(markdown).toContain("```text\nsecond\n```");
  });

  it("keeps the issue and the latest comment first, then the message", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue: { id: "i1", identifier: "HQ-1", title: "Do the thing", description: "Details" },
      wakeComment: { id: "c1", body: "Please hurry" },
      wakePrompts: ["And also this"],
    })!;
    expect(markdown.indexOf("Issue description:")).toBeLessThan(markdown.indexOf("Latest wake comment:"));
    expect(markdown.indexOf("Latest wake comment:")).toBeLessThan(markdown.indexOf("Message for this wake:"));
  });

  it("fences a message that contains backtick runs so it cannot escape the block", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue: null, wakePrompts: ["run ```rm -rf``` now"] })!;
    expect(markdown).toContain("````text\nrun ```rm -rf``` now\n````");
  });

  it("handles a very long message with many backtick runs, and cuts it to the limit", () => {
    const huge = "`a".repeat(200_000);
    const markdown = buildPaperclipTaskMarkdown({ issue: null, wakePrompts: [huge] })!;
    expect(markdown).toContain(`[message cut at ${MAX_WAKE_PROMPT_CHARS} characters]`);
    expect(markdown.length).toBeLessThan(MAX_WAKE_PROMPT_CHARS + 1_000);
  });

  it("still returns null when there is nothing to say", () => {
    expect(buildPaperclipTaskMarkdown({ issue: null, wakeComment: null, wakePrompts: ["   "] })).toBeNull();
    expect(buildPaperclipTaskMarkdown({ issue: null })).toBeNull();
  });
});

describe("wake messages when wakes merge", () => {
  it("reads one message or several", () => {
    expect(readWakePrompts({ [WAKE_PROMPT_CONTEXT_KEY]: " hi " })).toEqual(["hi"]);
    expect(readWakePrompts({ [WAKE_PROMPT_CONTEXT_KEY]: ["a", "", 3, "b"] })).toEqual(["a", "b"]);
    expect(readWakePrompts({})).toEqual([]);
    expect(readWakePrompts(null)).toEqual([]);
  });

  it("keeps both messages when a second wake joins a queued run", () => {
    const merged = mergeCoalescedContextSnapshot(
      { [WAKE_PROMPT_CONTEXT_KEY]: "first message", wakeReason: "agent_invoked" },
      { [WAKE_PROMPT_CONTEXT_KEY]: "second message", wakeReason: "agent_invoked" },
    );
    expect(merged[WAKE_PROMPT_CONTEXT_KEY]).toEqual(["first message", "second message"]);
  });

  it("keeps a pending approval revision actionable when a later ordinary comment joins", () => {
    const revision = {
      wakeReason: "approval_revision_requested",
      approvalId: "approval-1",
      revisionCycle: "2026-10-15T10:00:00.000Z",
      decisionNote: "Cite the source.",
    };
    const merged = mergeCoalescedContextSnapshot(revision, {
      wakeReason: "issue_commented",
      commentId: "comment-2",
    });
    expect(merged).toMatchObject({
      wakeReason: "approval_revision_requested",
      approvalId: "approval-1",
      revisionCycle: "2026-10-15T10:00:00.000Z",
      decisionNote: "Cite the source.",
      commentId: "comment-2",
    });
  });

  it.each(["approval_approved", "approval_rejected"])("lets a later %s wake supersede a pending revision", (wakeReason) => {
    const merged = mergeCoalescedContextSnapshot(
      { wakeReason: "approval_revision_requested", approvalId: "approval-1" },
      { wakeReason, approvalId: "approval-1" },
    );
    expect(merged.wakeReason).toBe(wakeReason);
  });

  it.each(["approval_approved", "approval_rejected"])("preserves a queued %s decision across a later ordinary comment", (wakeReason) => {
    const merged = mergeCoalescedContextSnapshot(
      { wakeReason, approvalId: "approval-1", approvalStatus: wakeReason.slice("approval_".length) },
      { wakeReason: "issue_commented", commentId: "comment-2" },
    );
    expect(merged).toMatchObject({ wakeReason, approvalId: "approval-1", commentId: "comment-2" });
  });

  it("keeps a message when the joining wake carries none, and the reverse", () => {
    expect(
      mergeCoalescedContextSnapshot({ [WAKE_PROMPT_CONTEXT_KEY]: "only message" }, { wakeReason: "timer" })[
        WAKE_PROMPT_CONTEXT_KEY
      ],
    ).toBe("only message");
    expect(
      mergeCoalescedContextSnapshot({ wakeReason: "timer" }, { [WAKE_PROMPT_CONTEXT_KEY]: "late message" })[
        WAKE_PROMPT_CONTEXT_KEY
      ],
    ).toBe("late message");
  });

  it("keeps the newest messages when a run collects too many", () => {
    let context: Record<string, unknown> = {};
    for (let i = 1; i <= MAX_WAKE_PROMPTS_PER_RUN + 5; i += 1) {
      context = mergeCoalescedContextSnapshot(context, { [WAKE_PROMPT_CONTEXT_KEY]: `message ${i}` });
    }
    const prompts = readWakePrompts(context);
    expect(prompts).toHaveLength(MAX_WAKE_PROMPTS_PER_RUN);
    expect(prompts.at(-1)).toBe(`message ${MAX_WAKE_PROMPTS_PER_RUN + 5}`);
  });
});
