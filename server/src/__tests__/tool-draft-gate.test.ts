import { beforeEach, describe, expect, it, vi } from "vitest";
import { OUTBOUND_TOOL_DRAFT_GATE } from "@paperclipai/shared";
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

/**
 * The summary is the one line that describes a draft wherever it is listed:
 * the Inbox, the agent's own tool result, and the Approve and Reject card in
 * Slack, where it is all the approver is shown. It used to read the recipient
 * from one fixed list of field names, which missed the field most messaging
 * tools actually use (a Slack DM's `userId`, a channel's `channelId`, a 3CX
 * call's `toNumber`) and named the sending `account` instead when there was
 * one. It also has to stay short enough for a Slack card, and must never be
 * the reason a draft fails.
 */
describe("tool draft gate: the summary names who a draft goes to", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApprovalService.create.mockResolvedValue({ id: "approval-summary" });
    mockApprovalService.list.mockResolvedValue([]);
    // Off, so a message with no named recipient is drafted rather than sent
    // as a note to the operator.
    mockInstanceSettingsService.getGeneral.mockResolvedValue(
      generalSettings({ skipApproval: false }),
    );
  });

  async function summarise(
    tool: string,
    params: Record<string, unknown>,
    gate?: Awaited<ReturnType<typeof loadDraftGate>>,
  ): Promise<string> {
    const draftGate = gate ?? (await loadDraftGate());
    const result = await draftGate.intercept(tool, params, ctx({}));
    expect(result.intercepted).toBe(true);
    const createArgs = mockApprovalService.create.mock.lastCall![1];
    return String((createArgs.payload as Record<string, unknown>).summary);
  }

  const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // One call per held tool, shaped like that plugin's manifest, and who the
  // summary has to name first (null where the call itself names no one).
  // Several carry an `account` on purpose: it is the sending account, and it
  // was what the summary named for the 3CX and Help Scout calls.
  const CASES: Array<[tool: string, params: Record<string, unknown>, recipient: string | null]> = [
    ["slack-tools:slack_send_dm", { workspace: "main", userId: "U0123ABCD", text: "Your order shipped." }, "U0123ABCD"],
    ["slack-tools:slack_send_channel", { workspace: "main", channelId: "C0123ABCD", text: "Deploy finished." }, "C0123ABCD"],
    [
      "email-tools:email_send",
      { mailbox: "personal", to: ["pat@example.com", "sam@example.com"], subject: "Your quote", body: "Attached." },
      "pat@example.com, sam@example.com",
    ],
    // The reply goes to whoever sent the original message, which the call
    // does not name.
    [
      "email-tools:email_reply",
      { mailbox: "personal", folder: "INBOX", uid: 42, body: "Thanks, Pat." },
      "the sender of the original message",
    ],
    [
      "help-scout:helpscout_send_reply",
      { account: "main", conversationId: "2913724936", body: "Your refund is on its way." },
      "the customer on conversation 2913724936",
    ],
    [
      "help-scout:helpscout_create_conversation",
      {
        account: "main",
        mailboxId: "1001",
        subject: "Your renewal",
        customer: { email: "pat@example.com", firstName: "Pat" },
        threads: [{ type: "reply", body: "We noticed your renewal did not go through." }],
      },
      "pat@example.com",
    ],
    ["phone-tools:phone_call_make", { account: "main", to: "+15551234567", assistant: "assistant-1" }, "+15551234567"],
    ["3cx-tools:pbx_click_to_call", { account: "main", fromExtension: "101", toNumber: "+15557654321" }, "+15557654321"],
    // Public posts name where the post appears.
    [
      "gbp-reviews:gbp_reply_to_review",
      { reviewName: "accounts/1/locations/2/reviews/3", locationKey: "main-st", replyText: "Thank you, Pat." },
      "main-st",
    ],
    [
      "review-tools:gbp_reply_to_review",
      { reviewName: "accounts/1/locations/2/reviews/3", locationKey: "main-st", replyText: "Thank you, Pat." },
      "main-st",
    ],
    ["social-poster:post_to_facebook", { page: "acme-shop", message: "Open late this Friday." }, "acme-shop"],
    ["social-poster:post_to_instagram", { account: "acme", image_url: "https://example.com/a.jpg", caption: "New stock." }, "acme"],
    ["social-poster:post_to_x", { account: "acme", text: "Open late this Friday." }, "acme"],
    ["social-poster:post_to_tiktok", { account: "acme", video_url: "https://example.com/a.mp4", text: "Behind the scenes." }, "acme"],
    ["social-poster:post_to_threads", { account: "acme", text: "Open late this Friday." }, "acme"],
    ["instagram-tools:instagram_post_photo", { account: "acme", imageUrl: "https://example.com/a.jpg", caption: "New stock." }, "acme"],
    [
      "instagram-tools:instagram_post_carousel",
      { account: "acme", items: [{ mediaUrl: "https://example.com/a.jpg" }], caption: "New stock." },
      "acme",
    ],
    ["instagram-tools:instagram_post_reel", { account: "acme", videoUrl: "https://example.com/a.mp4", caption: "Behind the scenes." }, "acme"],
    ["instagram-tools:instagram_post_story", { account: "acme", mediaUrl: "https://example.com/a.jpg" }, "acme"],
    [
      "youtube-tools:youtube_upload",
      { account: "main", filePath: "/videos/driveway.mp4", title: "How we resurface a driveway", description: "Start to finish." },
      "main",
    ],
    // A comment appears on the video; the account is only who posts it.
    ["youtube-tools:youtube_post_comment", { account: "main", videoId: "abc123", text: "Thanks for watching." }, "video abc123"],
    // Publishing a book addresses no one.
    ["kdp-tools:kdp_publish", { filePath: "/books/driveways.epub", contentType: "books" }, null],
  ];

  it("has a case for every tool the gate holds", () => {
    // A tool added to the gate without deciding where its recipient is read
    // from is how a Slack DM came to be approved without naming anyone.
    expect(CASES.map(([tool]) => tool).sort()).toEqual([...OUTBOUND_TOOL_DRAFT_GATE].sort());
  });

  it.each(CASES)("%s names its recipient first", async (tool, params, recipient) => {
    const summary = await summarise(tool, params);
    if (recipient === null) {
      expect(summary).not.toMatch(/^to /);
    } else {
      expect(summary).toMatch(new RegExp(`^to ${escapeRegExp(recipient)}( |$)`));
    }
  });

  it.each(CASES)("%s reads only its own recipient fields", async (tool, params) => {
    // The shared list for tools without a reader of their own would pick
    // these up, so an unchanged summary shows the tool has its own reader.
    const gate = await loadDraftGate();
    const plain = await summarise(tool, params, gate);
    const withStrayFields = await summarise(
      tool,
      { ...params, recipient: "stray@example.com", channel: "stray-channel" },
      gate,
    );
    expect(withStrayFields).toBe(plain);
  });

  it("names the default DM target when a Slack DM leaves out userId", async () => {
    // The plugin sends it to the workspace's default DM target then.
    const summary = await summarise("slack-tools:slack_send_dm", { workspace: "main", text: "Done." });
    expect(summary).toMatch(/^to the default DM target /);
  });

  it("names a Slack channel given by name, and the default channel when none is given", async () => {
    const gate = await loadDraftGate();
    expect(await summarise("slack-tools:slack_send_channel", { channelName: "ops", text: "Done." }, gate)).toMatch(
      /^to #ops /,
    );
    // channelId wins when both are given, as it does in the plugin.
    expect(
      await summarise("slack-tools:slack_send_channel", { channelId: "C0123ABCD", channelName: "ops", text: "Done." }, gate),
    ).toMatch(/^to C0123ABCD /);
    expect(await summarise("slack-tools:slack_send_channel", { text: "Done." }, gate)).toMatch(
      /^to the default channel /,
    );
  });

  it("names everyone an email is copied to", async () => {
    const summary = await summarise("email-tools:email_send", {
      mailbox: "personal",
      to: "Pat Example <pat@example.com>",
      cc: "sam@example.com",
      bcc: ["audit@example.com", "records@example.com"],
      subject: "Your quote",
      body: "Attached.",
    });
    expect(summary).toMatch(/^to Pat Example <pat@example\.com> /);
    expect(summary).toContain("cc sam@example.com");
    expect(summary).toContain("bcc audit@example.com, records@example.com");
  });

  it("says when an email reply goes to everyone on the original message", async () => {
    // The plugin copies everyone on the original for any truthy replyAll.
    const gate = await loadDraftGate();
    const base = { mailbox: "personal", uid: 42, body: "Thanks, all." };
    expect(await summarise("email-tools:email_reply", { ...base, replyAll: true }, gate)).toMatch(
      /^reply-all to the sender and everyone on the original message /,
    );
    expect(await summarise("email-tools:email_reply", { ...base, replyAll: "yes" }, gate)).toMatch(/^reply-all /);
    expect(await summarise("email-tools:email_reply", { ...base, replyAll: false }, gate)).toMatch(
      /^to the sender of the original message /,
    );
  });

  it("names who a Help Scout reply is addressed to, and who it is copied to", async () => {
    const gate = await loadDraftGate();
    const base = { account: "main", conversationId: "2913724936", body: "Your refund is on its way." };
    expect(await summarise("help-scout:helpscout_send_reply", { ...base, customerEmail: "pat@example.com" }, gate)).toMatch(
      /^to pat@example\.com /,
    );
    // The plugin uses customerId over customerEmail when both are given.
    expect(
      await summarise("help-scout:helpscout_send_reply", { ...base, customerId: 77, customerEmail: "pat@example.com" }, gate),
    ).toMatch(/^to Help Scout customer 77 /);
    const copied = await summarise(
      "help-scout:helpscout_send_reply",
      { ...base, cc: ["sam@example.com"], bcc: ["audit@example.com"] },
      gate,
    );
    expect(copied).toContain("cc sam@example.com");
    expect(copied).toContain("bcc audit@example.com");
  });

  it("says so, instead of naming anyone, when a Help Scout call sends nothing", async () => {
    const gate = await loadDraftGate();
    // An imported reply is only recorded in Help Scout.
    const imported = await summarise(
      "help-scout:helpscout_send_reply",
      {
        conversationId: "2913724936",
        customerEmail: "pat@example.com",
        cc: ["sam@example.com"],
        body: "Logged from the phone call.",
        imported: true,
      },
      gate,
    );
    expect(imported).toMatch(/^recorded in Help Scout only, nothing is sent /);
    expect(imported).not.toContain("pat@example.com");
    expect(imported).not.toContain("sam@example.com");

    // A conversation of internal notes reaches no customer.
    const notes = await summarise(
      "help-scout:helpscout_create_conversation",
      {
        subject: "Call log",
        customer: { email: "pat@example.com" },
        threads: [{ type: "note", body: "Called Pat back." }],
      },
      gate,
    );
    expect(notes).toMatch(/^internal notes only, nothing is sent /);
    expect(notes).not.toContain("pat@example.com");
  });

  it("names who each Help Scout thread goes to", async () => {
    // A thread's own customerEmail replaces the conversation's customer for
    // that thread, and a note goes to no one.
    const summary = await summarise("help-scout:helpscout_create_conversation", {
      subject: "Your renewal",
      customer: { email: "pat@example.com" },
      threads: [
        { type: "note", body: "Spoke to Sam first.", customerEmail: "note@example.com" },
        { type: "reply", body: "Hi Sam.", customerEmail: "sam@example.com" },
        { type: "reply", body: "Hi Pat." },
      ],
    });
    expect(summary).toMatch(/^to sam@example\.com, pat@example\.com /);
    expect(summary).not.toContain("note@example.com");
  });

  it("does not read a field as the recipient where the tool uses it for something else", async () => {
    // email_reply ignores `to`: the reply goes to the original sender, so a
    // stray `to` must not be shown as where it is going.
    const reply = await summarise("email-tools:email_reply", {
      mailbox: "personal",
      uid: 42,
      to: "someone-else@example.com",
      body: "Thanks, Pat.",
    });
    expect(reply).not.toContain("someone-else@example.com");

    // On a Help Scout note `userId` is who the note is attributed to, so an
    // operator asking to approve notes must not be told it goes to them.
    const gate = await loadDraftGateWithOperatorRule(["help-scout:helpscout_add_note"]);
    const note = await summarise(
      "help-scout:helpscout_add_note",
      { account: "main", conversationId: "2913724936", userId: "555", body: "Called the customer back." },
      gate,
    );
    expect(note).not.toContain("555");
  });

  it("does not name the account a call goes out from, or the thing it changes, as its recipient", async () => {
    // An operator can ask to approve any operation. In these, `account` picks
    // the account to act as, `conversationId` the conversation being changed
    // and `locationKey` the location being synced; none of them is sent anything.
    const gate = await loadDraftGateWithOperatorRule([
      "3cx-tools:pbx_park_call",
      "help-scout:helpscout_update_customer_properties",
      "help-scout:helpscout_change_status",
      "review-tools:gbp_sync_location",
    ]);
    expect(await summarise("3cx-tools:pbx_park_call", { account: "main", callId: "call-1" }, gate)).not.toMatch(/^to /);
    expect(
      await summarise(
        "help-scout:helpscout_update_customer_properties",
        { account: "main", customerId: "77", properties: { plan: "pro" } },
        gate,
      ),
    ).not.toMatch(/^to /);
    expect(
      await summarise(
        "help-scout:helpscout_change_status",
        { account: "main", conversationId: "2913724936", status: "closed" },
        gate,
      ),
    ).not.toMatch(/^to /);
    expect(await summarise("review-tools:gbp_sync_location", { locationKey: "main-st" }, gate)).not.toMatch(/^to /);
  });

  describe("odd parameter shapes", () => {
    it("Slack: names a default only when the field is left out", async () => {
      const gate = await loadDraftGate();
      const dm = (userId: unknown) => summarise("slack-tools:slack_send_dm", { userId, text: "Hi." }, gate);
      expect(await dm(null)).toMatch(/^to the default DM target /);
      expect(await dm(12345)).toMatch(/^to 12345 /);
      // The plugin sends to whatever userId holds, so an object is neither
      // the default target nor a readable id.
      for (const userId of [{ id: "U0123ABCD" }, [{ id: "U0123ABCD" }]]) {
        const summary = await dm(userId);
        expect(summary).not.toMatch(/^to /);
        expect(summary).not.toContain("[object Object]");
      }

      const channel = (params: Record<string, unknown>) =>
        summarise("slack-tools:slack_send_channel", { ...params, text: "Hi." }, gate);
      expect(await channel({ channelId: null, channelName: null })).toMatch(/^to the default channel /);
      expect(await channel({ channelId: { id: "C0123ABCD" } })).not.toMatch(/^to /);
    });

    it("email: reads an address object the mail library sends to, and nothing that is not an address", async () => {
      const gate = await loadDraftGate();
      const send = (params: Record<string, unknown>) =>
        summarise("email-tools:email_send", { mailbox: "personal", subject: "Hello", body: "Hi.", ...params }, gate);
      expect(await send({ to: { name: "Pat Example", address: "pat@example.com" } })).toMatch(
        /^to Pat Example <pat@example\.com> re: /,
      );
      // Inside a list the plugin turns an object into text that is not an
      // address, so only the real one is sent anything.
      expect(await send({ to: [{ address: "lee@example.com" }, "sam@example.com"] })).toMatch(
        /^to sam@example\.com re: /,
      );
      expect(await send({ to: "pat@example.com", cc: null, bcc: [null, {}] })).toMatch(/^to pat@example\.com re: /);
      expect(await send({ to: null })).toMatch(/^re: Hello /);
    });

    it("Help Scout: copes with numbers, nested objects and lists of objects", async () => {
      const gate = await loadDraftGate();
      const reply = (params: Record<string, unknown>) =>
        summarise("help-scout:helpscout_send_reply", { body: "Hi.", ...params }, gate);
      expect(await reply({ conversationId: 2913724936 })).toMatch(/^to the customer on conversation 2913724936 /);
      const copied = await reply({
        conversationId: "2913724936",
        cc: "sam@example.com",
        bcc: [{ email: "lee@example.com" }],
      });
      expect(copied).toContain("cc sam@example.com");
      expect(copied).not.toContain("bcc");
      expect(await reply({ conversationId: "2913724936", customerId: { id: 77 } })).not.toContain("[object Object]");

      const conversation = (params: Record<string, unknown>) =>
        summarise("help-scout:helpscout_create_conversation", { subject: "Your renewal", ...params }, gate);
      // A thread that is not an object still goes to the conversation's customer.
      expect(await conversation({ customer: { email: "pat@example.com" }, threads: [null, "reply"] })).toMatch(
        /^to pat@example\.com re: /,
      );
      expect(await conversation({ customer: "pat@example.com", threads: { type: "reply" } })).toBe("re: Your renewal");
    });
  });

  describe("staying short, and never being the reason a draft fails", () => {
    it("shows three names from a long list and counts the rest", async () => {
      const everyone = Array.from({ length: 10 }, (_, index) => `person${index + 1}@example.com`);
      const summary = await summarise("email-tools:email_send", {
        mailbox: "personal",
        to: everyone,
        // One string can carry several addresses too.
        cc: everyone.slice(0, 5).join(", "),
        subject: "Team update",
        body: "Hi all.",
      });
      expect(summary).toMatch(
        /^to person1@example\.com, person2@example\.com, person3@example\.com and 7 more cc person1@example\.com, person2@example\.com, person3@example\.com and 2 more re: Team update /,
      );
    });

    it("keeps a long display name's address when it has to shorten it", async () => {
      const summary = await summarise("email-tools:email_send", {
        mailbox: "personal",
        to: `${"Pat Example of the Very Long Department Name ".repeat(3)}<pat@example.com>`,
        subject: "Hello",
        body: "Hi.",
      });
      expect(summary).toMatch(/^to pat@example\.com re: /);
    });

    it("keeps the whole summary short however long the call is", async () => {
      // Slack refuses a card over 3000 characters, and with it the reply and
      // any later approvals in that turn.
      const long = (label: string) => `${label}-${"x".repeat(5000)}@example.com`;
      const summary = await summarise("email-tools:email_send", {
        mailbox: "personal",
        to: [long("a"), long("b"), long("c"), long("d")],
        cc: [long("e")],
        bcc: [long("f")],
        subject: "s".repeat(5000),
        body: "b".repeat(5000),
      });
      expect(Array.from(summary).length).toBeLessThanOrEqual(500);
      expect(summary).toMatch(/^to a-x+…, b-x+…, c-x+… and 1 more cc e-x+… bcc f-x+… re: s+…/);
    });

    it("never cuts a character in half, which the database refuses to store", async () => {
      // Postgres will not store JSON holding half of an emoji, so a summary
      // cut there failed the draft, and the agent's tool call with it.
      // A run of emoji across the cut, so a cut that counts code units splits one.
      const caption = `${"a".repeat(130)}${"\u{1F600}".repeat(20)} and a few more words after the cut`;
      const summary = await summarise("social-poster:post_to_x", { account: "acme", text: caption });
      expect(summary).toContain("…");
      expect(() => encodeURIComponent(summary)).not.toThrow();
    });

    it("falls back to the tool name when the parameters cannot be read", async () => {
      // A field that throws when read stands in for anything unexpected. The
      // summary only describes the call; it must not stop the draft.
      const params = Object.defineProperty({ text: "Hi." }, "userId", {
        get() {
          throw new Error("unreadable");
        },
      });
      const gate = await loadDraftGate();
      const result = await gate.intercept("slack-tools:slack_send_dm", params, ctx({}));
      expect(result.intercepted).toBe(true);
      const createArgs = mockApprovalService.create.mock.lastCall![1];
      expect((createArgs.payload as Record<string, unknown>).summary).toBe("slack-tools:slack_send_dm");
    });
  });
});
