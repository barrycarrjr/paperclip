import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
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

const stubDb = {} as never;

async function loadDraftGate() {
  const { createDraftGate } = await import("../services/tool-draft-gate.js");
  return createDraftGate({ db: stubDb });
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
      generalSettings({ emails: ["Barry@Example.com"] }),
    );
    const gate = await loadDraftGate();
    const result = await gate.intercept(
      "email-tools:email_send",
      {
        mailbox: "personal",
        to: 'Barry Carr <barry@example.com>',
        cc: ["barry@example.com"],
        subject: "note to self",
        body: "x",
      },
      ctx({}),
    );

    expect(result.intercepted).toBe(false);
  });

  it("an email that copies anyone else stays held", async () => {
    mockInstanceSettingsService.getGeneral.mockResolvedValue(
      generalSettings({ emails: ["barry@example.com"] }),
    );
    const gate = await loadDraftGate();
    const result = await gate.intercept(
      "email-tools:email_send",
      {
        mailbox: "personal",
        to: "barry@example.com, customer@other.com",
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
      { mailbox: "personal", to: "barry@example.com", subject: "s", body: "x" },
      ctx({}),
    );

    expect(result.intercepted).toBe(true);
  });

  it("email replies are always held (recipient is implicit in the thread)", async () => {
    mockInstanceSettingsService.getGeneral.mockResolvedValue(
      generalSettings({ emails: ["barry@example.com"] }),
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
      generalSettings({ emails: ["barry@example.com"] }),
    );
    const gate = await loadDraftGate();
    const result = await gate.intercept(
      "email-tools:email_send",
      { mailbox: "personal", to: [{ address: "barry@example.com" }], subject: "s", body: "x" },
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
        generalSettings({ skipApproval: true, emails: ["barry@example.com"] }),
      );
      const gate = await loadDraftGate();
      const result = await gate.intercept(
        "email-tools:email_send",
        { to: "barry@example.com", subject: "s", body: "b" },
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
