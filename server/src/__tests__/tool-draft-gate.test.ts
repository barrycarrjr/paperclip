import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(async () => []),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(async () => ({ outboundToolDraftMode: true })),
}));

// Typed signature so `mockLogActivity.mock.calls[N][1]` is the activity
// payload (not `undefined`) under noUncheckedIndexedAccess. Matches the real
// `logActivity(db, input)` shape from services/activity-log.ts loosely; only
// the fields the tests assert on are needed.
type LogActivityArgs = {
  companyId: string;
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId?: string | null;
  runId?: string | null;
  details?: Record<string, unknown> | null;
};
const mockLogActivity = vi.hoisted(() =>
  vi.fn(async (_db: unknown, _args: LogActivityArgs) => undefined),
);

vi.mock("../services/approvals.js", () => ({
  approvalService: () => mockApprovalService,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  link: vi.fn(async () => ({ issueId: "issue-1" })),
}));

vi.mock("../services/issue-approvals.js", () => ({
  issueApprovalService: () => mockIssueApprovalService,
}));

const stubDb = {} as never;

/**
 * A database stub that answers exactly one question: which issue was this run
 * working on. Shaped like the drizzle chain the gate uses
 * (`select().from().where().then()`), because that is all it has to satisfy.
 */
function dbReturningRunIssue(issueId: string | null) {
  const rows = issueId === null ? [] : [{ contextSnapshot: { issueId } }];
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve),
        }),
      }),
    }),
  } as never;
}

/**
 * A run woken by an approval that carries no issue of its own, plus the issue
 * that approval was linked to. The gate has to make two queries to find it:
 * the run's snapshot first, then the link table.
 */
function dbReturningApprovalWake(approvalId: string, linkedIssueId: string | null) {
  let call = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          then: (resolve: (value: unknown) => unknown) => {
            call += 1;
            const rows =
              call === 1
                ? [{ contextSnapshot: { approvalId, issueId: null } }]
                : linkedIssueId === null
                  ? []
                  : [{ issueId: linkedIssueId }];
            return Promise.resolve(rows).then(resolve);
          },
        }),
      }),
    }),
  } as never;
}

async function loadDraftGate(db: never = stubDb) {
  const { createDraftGate } = await import("../services/tool-draft-gate.js");
  return createDraftGate({ db });
}

/**
 * A gate that also treats whatever the operator flagged as needing approval.
 * The built-in outbound list is fixed at module load and knows nothing about
 * which plugins are installed, so the answer is asked for at call time.
 */
async function loadDraftGateWithOperatorRule(
  gatedNames: string[],
  db: never = stubDb,
) {
  const { createDraftGate } = await import("../services/tool-draft-gate.js");
  return createDraftGate({
    db,
    isAdditionallyGated: (name) => gatedNames.includes(name),
  });
}

function ctx(overrides: Partial<ToolRunContext>): ToolRunContext {
  return {
    agentId: "00000000-0000-0000-0000-000000000000",
    runId: "00000000-0000-0000-0000-000000000000",
    companyId: "00000000-0000-0000-0000-0000000000aa",
    projectId: "",
    ...overrides,
  };
}

describe("tool draft gate — synthetic agent id handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApprovalService.create.mockResolvedValue({ id: "approval-1" });
  });

  it("routes Clippy invocations through requestedByUserId, not requestedByAgentId", async () => {
    const gate = await loadDraftGate();
    const result = await gate.intercept(
      "3cx-tools:pbx_click_to_call",
      { toNumber: "+15555550199", fromExtension: "200" },
      ctx({ agentId: "clippy:user-abc-123" }),
    );

    expect(result.intercepted).toBe(true);
    expect(mockApprovalService.create).toHaveBeenCalledTimes(1);
    const createArgs = mockApprovalService.create.mock.calls[0]![1];
    expect(createArgs.requestedByAgentId).toBeNull();
    expect(createArgs.requestedByUserId).toBe("user-abc-123");
    // Original synthetic id is preserved in the payload for traceability.
    expect((createArgs.payload as Record<string, unknown>).agentId).toBe(
      "clippy:user-abc-123",
    );
  });

  it("nulls activity-log agentId/runId for Clippy invocations", async () => {
    const gate = await loadDraftGate();
    await gate.intercept(
      "3cx-tools:pbx_click_to_call",
      { toNumber: "+15555550199", fromExtension: "200" },
      ctx({ agentId: "clippy:user-abc-123", runId: "11111111-1111-1111-1111-111111111111" }),
    );

    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    const logArgs = mockLogActivity.mock.calls[0]![1];
    expect(logArgs.actorType).toBe("user");
    expect(logArgs.actorId).toBe("user-abc-123");
    expect(logArgs.agentId).toBeNull();
    // The synthetic runId from chat-tools doesn't reference a real
    // heartbeat_runs row, so we drop it to avoid an FK violation.
    expect(logArgs.runId).toBeNull();
  });

  it("preserves real agent ids verbatim", async () => {
    const gate = await loadDraftGate();
    const realAgentId = "22222222-2222-2222-2222-222222222222";
    const realRunId = "33333333-3333-3333-3333-333333333333";
    await gate.intercept(
      "3cx-tools:pbx_click_to_call",
      { toNumber: "+15555550199", fromExtension: "200" },
      ctx({ agentId: realAgentId, runId: realRunId }),
    );

    const createArgs = mockApprovalService.create.mock.calls[0]![1];
    expect(createArgs.requestedByAgentId).toBe(realAgentId);
    expect(createArgs.requestedByUserId).toBeNull();

    const logArgs = mockLogActivity.mock.calls[0]![1];
    expect(logArgs.actorType).toBe("agent");
    expect(logArgs.actorId).toBe(realAgentId);
    expect(logArgs.agentId).toBe(realAgentId);
    expect(logArgs.runId).toBe(realRunId);
  });

  it("persists chatSessionId on the approval payload when present", async () => {
    const gate = await loadDraftGate();
    const sessionId = "44444444-4444-4444-4444-444444444444";
    await gate.intercept(
      "3cx-tools:pbx_click_to_call",
      { toNumber: "+15555550199", fromExtension: "200" },
      ctx({ agentId: "clippy:user-abc-123", chatSessionId: sessionId }),
    );

    const createArgs = mockApprovalService.create.mock.calls[0]![1];
    expect((createArgs.payload as Record<string, unknown>).chatSessionId).toBe(sessionId);
  });

  it("stores chatSessionId as null when the caller did not set one", async () => {
    const gate = await loadDraftGate();
    await gate.intercept(
      "3cx-tools:pbx_click_to_call",
      { toNumber: "+15555550199", fromExtension: "200" },
      ctx({ agentId: "22222222-2222-2222-2222-222222222222" }),
    );

    const createArgs = mockApprovalService.create.mock.calls[0]![1];
    expect((createArgs.payload as Record<string, unknown>).chatSessionId).toBeNull();
  });
});

interface SelfNotifyOverrides {
  skipApproval?: boolean;
  slackUserIds?: string[];
  emails?: string[];
  phoneNumbers?: string[];
}

function generalSettings(selfNotify: SelfNotifyOverrides = {}, outboundToolDraftMode = true) {
  return {
    outboundToolDraftMode,
    selfNotify: {
      skipApproval: true,
      slackUserIds: [],
      emails: [],
      phoneNumbers: [],
      ...selfNotify,
    },
  };
}

describe("tool draft gate — self-notification bypass", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApprovalService.create.mockResolvedValue({ id: "approval-1" });
    mockInstanceSettingsService.getGeneral.mockResolvedValue(generalSettings());
  });

  it("a Slack DM with no explicit recipient (default DM target = operator) sends without approval", async () => {
    const gate = await loadDraftGate();
    const result = await gate.intercept(
      "slack-tools:slack_send_dm",
      { text: "Steward sweep: 0 secrets found." },
      ctx({}),
    );

    expect(result.intercepted).toBe(false);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("a Slack DM to one of the operator's IDs sends without approval (case-insensitive)", async () => {
    mockInstanceSettingsService.getGeneral.mockResolvedValue(
      generalSettings({ slackUserIds: ["u0aaa111"] }),
    );
    const gate = await loadDraftGate();
    const result = await gate.intercept(
      "slack-tools:slack_send_dm",
      { userId: "U0AAA111", text: "hi" },
      ctx({}),
    );

    expect(result.intercepted).toBe(false);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("a Slack DM to someone else's ID is still held for approval", async () => {
    mockInstanceSettingsService.getGeneral.mockResolvedValue(
      generalSettings({ slackUserIds: ["U0AAA111"] }),
    );
    const gate = await loadDraftGate();
    const result = await gate.intercept(
      "slack-tools:slack_send_dm",
      { userId: "U0BBB222", text: "hi" },
      ctx({}),
    );

    expect(result.intercepted).toBe(true);
    expect(mockApprovalService.create).toHaveBeenCalledTimes(1);
  });

  it("turning skipApproval off restores the hold even for recipient-less DMs", async () => {
    mockInstanceSettingsService.getGeneral.mockResolvedValue(
      generalSettings({ skipApproval: false }),
    );
    const gate = await loadDraftGate();
    const result = await gate.intercept(
      "slack-tools:slack_send_dm",
      { text: "hello" },
      ctx({}),
    );

    expect(result.intercepted).toBe(true);
  });

  it("channel posts are never treated as self-addressed", async () => {
    const gate = await loadDraftGate();
    const result = await gate.intercept(
      "slack-tools:slack_send_channel",
      { text: "hello ops" },
      ctx({}),
    );

    expect(result.intercepted).toBe(true);
  });

  it("an email whose every recipient is the operator sends without approval", async () => {
    mockInstanceSettingsService.getGeneral.mockResolvedValue(
      generalSettings({ emails: ["Owner@Example.com"] }),
    );
    const gate = await loadDraftGate();
    const result = await gate.intercept(
      "email-tools:email_send",
      {
        mailbox: "personal",
        to: 'Alex Owner <owner@example.com>',
        cc: ["owner@example.com"],
        subject: "note to self",
        body: "x",
      },
      ctx({}),
    );

    expect(result.intercepted).toBe(false);
  });

  it("an email that copies anyone else stays held", async () => {
    mockInstanceSettingsService.getGeneral.mockResolvedValue(
      generalSettings({ emails: ["owner@example.com"] }),
    );
    const gate = await loadDraftGate();
    const result = await gate.intercept(
      "email-tools:email_send",
      {
        mailbox: "personal",
        to: "owner@example.com, customer@other.com",
        subject: "s",
        body: "x",
      },
      ctx({}),
    );

    expect(result.intercepted).toBe(true);
  });

  it("an email with no configured self addresses stays held", async () => {
    const gate = await loadDraftGate();
    const result = await gate.intercept(
      "email-tools:email_send",
      { mailbox: "personal", to: "owner@example.com", subject: "s", body: "x" },
      ctx({}),
    );

    expect(result.intercepted).toBe(true);
  });

  it("email replies are always held (recipient is implicit in the thread)", async () => {
    mockInstanceSettingsService.getGeneral.mockResolvedValue(
      generalSettings({ emails: ["owner@example.com"] }),
    );
    const gate = await loadDraftGate();
    const result = await gate.intercept(
      "email-tools:email_reply",
      { mailbox: "personal", uid: 42, body: "reply" },
      ctx({}),
    );

    expect(result.intercepted).toBe(true);
  });

  it("an unreadable recipient shape stays held", async () => {
    mockInstanceSettingsService.getGeneral.mockResolvedValue(
      generalSettings({ emails: ["owner@example.com"] }),
    );
    const gate = await loadDraftGate();
    const result = await gate.intercept(
      "email-tools:email_send",
      { mailbox: "personal", to: [{ address: "owner@example.com" }], subject: "s", body: "x" },
      ctx({}),
    );

    expect(result.intercepted).toBe(true);
  });

  it("a phone call to the operator's own number skips approval regardless of formatting", async () => {
    mockInstanceSettingsService.getGeneral.mockResolvedValue(
      generalSettings({ phoneNumbers: ["+1 (555) 123-4567"] }),
    );
    const gate = await loadDraftGate();
    const result = await gate.intercept(
      "phone-tools:phone_call_make",
      { to: "+15551234567", assistant: "reminder" },
      ctx({}),
    );

    expect(result.intercepted).toBe(false);
  });

  it("a phone call to any other number stays held", async () => {
    mockInstanceSettingsService.getGeneral.mockResolvedValue(
      generalSettings({ phoneNumbers: ["+15551234567"] }),
    );
    const gate = await loadDraftGate();
    const result = await gate.intercept(
      "phone-tools:phone_call_make",
      { to: "+15559876543" },
      ctx({}),
    );

    expect(result.intercepted).toBe(true);
  });

  it("outboundToolDraftMode=false disables the gate entirely", async () => {
    mockInstanceSettingsService.getGeneral.mockResolvedValue(
      generalSettings({ skipApproval: false }, false),
    );
    const gate = await loadDraftGate();
    const result = await gate.intercept(
      "slack-tools:slack_send_channel",
      { text: "hello" },
      ctx({}),
    );

    expect(result.intercepted).toBe(false);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  describe("force", () => {
    it("drafts anyway when the instance-wide hold is off", async () => {
      mockInstanceSettingsService.getGeneral.mockResolvedValue(
        generalSettings({ skipApproval: false }, false),
      );
      const gate = await loadDraftGate();
      const result = await gate.intercept(
        "email-tools:email_reply",
        { mailbox: "personal", messageId: "<a@b>", body: "hi" },
        ctx({}),
        { force: true },
      );

      expect(result.intercepted).toBe(true);
      expect(mockApprovalService.create).toHaveBeenCalled();
    });

    it("drafts anyway when the message is addressed to the operator", async () => {
      // A caller that has said "always ask me about these" has already
      // answered the question the self-notification bypass exists to answer.
      mockInstanceSettingsService.getGeneral.mockResolvedValue(
        generalSettings({ skipApproval: true, emails: ["owner@example.com"] }),
      );
      const gate = await loadDraftGate();
      const result = await gate.intercept(
        "email-tools:email_send",
        { to: "owner@example.com", subject: "s", body: "b" },
        ctx({}),
        { force: true },
      );

      expect(result.intercepted).toBe(true);
    });

    it("does not make an ungated tool draftable", async () => {
      // Nothing would know how to replay it after approval, so forcing must
      // not widen what the gate covers.
      const gate = await loadDraftGate();
      const result = await gate.intercept(
        "email-tools:email_search",
        { query: "invoice" },
        ctx({}),
        { force: true },
      );

      expect(result.intercepted).toBe(false);
      expect(mockApprovalService.create).not.toHaveBeenCalled();
    });

    it("changes nothing when it is not asked for", async () => {
      mockInstanceSettingsService.getGeneral.mockResolvedValue(
        generalSettings({ skipApproval: false }, false),
      );
      const gate = await loadDraftGate();
      const result = await gate.intercept(
        "email-tools:email_reply",
        { mailbox: "personal", messageId: "<a@b>", body: "hi" },
        ctx({}),
      );

      expect(result.intercepted).toBe(false);
    });
  });
});

describe("tool draft gate — the issue a draft belongs to", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApprovalService.create.mockResolvedValue({ id: "approval-1" });
    mockInstanceSettingsService.getGeneral.mockResolvedValue({ outboundToolDraftMode: true });
  });

  it("links the draft to the issue the run was working on", async () => {
    // Without this the approval exists in isolation: the issue that prompted
    // the message says nothing about it having been drafted or sent, and the
    // post-approval wake has no issue to point the agent at.
    const gate = await loadDraftGate(dbReturningRunIssue("issue-42"));
    await gate.intercept(
      "slack-tools:slack_send_dm",
      { userId: "U123", text: "hello" },
      ctx({ runId: "run-7" }),
    );

    expect(mockIssueApprovalService.link).toHaveBeenCalledWith(
      "issue-42",
      "approval-1",
      expect.anything(),
    );
  });

  it("drafts fine when the run has no issue", async () => {
    const gate = await loadDraftGate(dbReturningRunIssue(null));
    const result = await gate.intercept(
      "slack-tools:slack_send_dm",
      { userId: "U123", text: "hello" },
      ctx({ runId: "run-8" }),
    );

    expect(result.intercepted).toBe(true);
    expect(mockIssueApprovalService.link).not.toHaveBeenCalled();
  });

  it("still drafts when linking throws", async () => {
    mockIssueApprovalService.link.mockRejectedValueOnce(new Error("db down"));
    const gate = await loadDraftGate(dbReturningRunIssue("issue-42"));
    const result = await gate.intercept(
      "slack-tools:slack_send_dm",
      { userId: "U123", text: "hello" },
      ctx({ runId: "run-9" }),
    );

    expect(result.intercepted).toBe(true);
    expect(mockApprovalService.create).toHaveBeenCalledTimes(1);
  });

  it("tells the caller in plain words that nothing has been sent", async () => {
    // An agent read the old wording as close enough to done and commented
    // "Reached out to Brandon Carr via Slack DM" on the issue before the
    // operator had even been asked.
    const gate = await loadDraftGate(dbReturningRunIssue(null));
    const result = await gate.intercept(
      "slack-tools:slack_send_dm",
      { userId: "U123", text: "hello" },
      ctx({ runId: "run-10" }),
    );

    const content = String(result.result?.content ?? "");
    expect(content).toContain("NOTHING HAS BEEN SENT");
    expect(content).toMatch(/do not write, comment or report/i);
  });
});

describe("tool draft gate — the approve-and-redraft loop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApprovalService.create.mockResolvedValue({ id: "approval-1" });
    mockApprovalService.list.mockResolvedValue([]);
    mockInstanceSettingsService.getGeneral.mockResolvedValue({ outboundToolDraftMode: true });
  });

  const params = { userId: "U123", text: "the issue is blocked, waiting on Brandon" };

  function pendingDraft(id: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      type: "outbound_tool_draft",
      status: "pending",
      payload: { toolName: "slack-tools:slack_send_dm", parameters: params, ...overrides },
    };
  }

  it("hands back the waiting draft instead of queueing the same message twice", async () => {
    // Approving a draft wakes the agent that asked for it; an agent that wakes
    // with nothing to do sometimes drafts another status message, which is
    // approved, which wakes it again. Four identical Slack DMs in three
    // minutes came out of that, each needing its own tap.
    mockApprovalService.list.mockResolvedValue([pendingDraft("approval-waiting")]);
    const gate = await loadDraftGate(dbReturningRunIssue(null));

    const result = await gate.intercept("slack-tools:slack_send_dm", params, ctx({}));

    expect(result.intercepted).toBe(true);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
    expect((result.result?.data as Record<string, unknown>).duplicateOf).toBe("approval-waiting");
    expect(String(result.result?.content)).toMatch(/ALREADY waiting/);
    // Told not to reword its way around the check, because that is the obvious
    // next move for a model that wants to report progress.
    expect(String(result.result?.content)).toMatch(/do not rephrase/i);
  });

  it("ignores key order when deciding two calls are the same", async () => {
    mockApprovalService.list.mockResolvedValue([
      pendingDraft("approval-waiting", { parameters: { text: params.text, userId: params.userId } }),
    ]);
    const gate = await loadDraftGate(dbReturningRunIssue(null));

    const result = await gate.intercept("slack-tools:slack_send_dm", params, ctx({}));

    expect(mockApprovalService.create).not.toHaveBeenCalled();
    expect((result.result?.data as Record<string, unknown>).duplicateOf).toBe("approval-waiting");
  });

  it("still queues a genuinely different message", async () => {
    mockApprovalService.list.mockResolvedValue([pendingDraft("approval-waiting")]);
    const gate = await loadDraftGate(dbReturningRunIssue(null));

    await gate.intercept(
      "slack-tools:slack_send_dm",
      { userId: "U123", text: "something else entirely" },
      ctx({}),
    );

    expect(mockApprovalService.create).toHaveBeenCalledTimes(1);
  });

  it("still queues the same text to a different person", async () => {
    mockApprovalService.list.mockResolvedValue([pendingDraft("approval-waiting")]);
    const gate = await loadDraftGate(dbReturningRunIssue(null));

    await gate.intercept(
      "slack-tools:slack_send_dm",
      { userId: "U999", text: params.text },
      ctx({}),
    );

    expect(mockApprovalService.create).toHaveBeenCalledTimes(1);
  });

  it("queues normally when the pending list cannot be read", async () => {
    // Risking a second draft beats dropping the call.
    mockApprovalService.list.mockRejectedValue(new Error("db down"));
    const gate = await loadDraftGate(dbReturningRunIssue(null));

    const result = await gate.intercept("slack-tools:slack_send_dm", params, ctx({}));

    expect(result.intercepted).toBe(true);
    expect(mockApprovalService.create).toHaveBeenCalledTimes(1);
  });
});

describe("tool draft gate — carrying the issue across an approval wake", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApprovalService.create.mockResolvedValue({ id: "approval-2" });
    mockApprovalService.list.mockResolvedValue([]);
    mockInstanceSettingsService.getGeneral.mockResolvedValue({ outboundToolDraftMode: true });
  });

  it("inherits the issue from the approval that woke the run", async () => {
    // The run has no issue of its own — an approval_approved wake carries the
    // approval, not the work. Without following it back, every draft made in
    // such a run is unlinked, so its own approval wakes the agent with no
    // issue either, and the chain never re-attaches.
    const gate = await loadDraftGate(dbReturningApprovalWake("approval-waking", "issue-42"));

    await gate.intercept(
      "slack-tools:slack_send_dm",
      { userId: "U123", text: "status" },
      ctx({ runId: "run-woken" }),
    );

    expect(mockIssueApprovalService.link).toHaveBeenCalledWith(
      "issue-42",
      "approval-2",
      expect.anything(),
    );
  });

  it("links nothing when the waking approval had no issue either", async () => {
    const gate = await loadDraftGate(dbReturningApprovalWake("approval-waking", null));

    const result = await gate.intercept(
      "slack-tools:slack_send_dm",
      { userId: "U123", text: "status" },
      ctx({ runId: "run-woken" }),
    );

    expect(result.intercepted).toBe(true);
    expect(mockIssueApprovalService.link).not.toHaveBeenCalled();
  });
});

/**
 * An operator can require approval on a plugin operation the built-in outbound
 * list has never heard of. Replaying an approved draft is already generic — it
 * re-dispatches the tool name with its stored parameters — so the gate is the
 * only piece that had to learn anything.
 *
 * @see PLUGIN_SPEC.md §11.8 — Operator control over operations
 */
describe("tool draft gate — operator-required approvals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApprovalService.create.mockResolvedValue({ id: "approval-op" });
    mockApprovalService.list.mockResolvedValue([]);
    mockInstanceSettingsService.getGeneral.mockResolvedValue({ outboundToolDraftMode: true });
  });

  it("drafts an operation the operator flagged, even though it is not an outbound tool", async () => {
    const gate = await loadDraftGateWithOperatorRule(["acme.ops:send-invoice"]);

    const result = await gate.intercept("acme.ops:send-invoice", { customerId: "c-1" }, ctx({}));

    expect(result.intercepted).toBe(true);
    expect(mockApprovalService.create).toHaveBeenCalledTimes(1);
  });

  it("reports it as gated", async () => {
    const gate = await loadDraftGateWithOperatorRule(["acme.ops:send-invoice"]);

    expect(gate.isGated("acme.ops:send-invoice")).toBe(true);
    expect(gate.isGated("acme.ops:read-invoice")).toBe(false);
  });

  it("holds it even when the instance-wide outbound hold is off", async () => {
    mockInstanceSettingsService.getGeneral.mockResolvedValue({ outboundToolDraftMode: false });
    const gate = await loadDraftGateWithOperatorRule(["acme.ops:send-invoice"]);

    // The operator said so about this specific operation, so the general
    // toggle does not get to overrule them.
    const result = await gate.intercept("acme.ops:send-invoice", {}, ctx({}));

    expect(result.intercepted).toBe(true);
  });

  it("leaves everything else alone", async () => {
    const gate = await loadDraftGateWithOperatorRule(["acme.ops:send-invoice"]);

    const result = await gate.intercept("acme.ops:read-invoice", {}, ctx({}));

    expect(result.intercepted).toBe(false);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("behaves as before when the callback throws", async () => {
    const { createDraftGate } = await import("../services/tool-draft-gate.js");
    const gate = createDraftGate({
      db: stubDb,
      isAdditionallyGated: () => { throw new Error("registry not ready"); },
    });

    // A plugin mid-reload must not turn every tool call in the instance into
    // an error.
    const result = await gate.intercept("acme.ops:send-invoice", {}, ctx({}));

    expect(result.intercepted).toBe(false);
  });
});
