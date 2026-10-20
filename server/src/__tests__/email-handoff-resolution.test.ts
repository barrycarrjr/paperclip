import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildEmailHandoffOriginId } from "@paperclipai/shared";

const mockGetGeneral = vi.hoisted(() => vi.fn());
const mockTransition = vi.hoisted(() => vi.fn());
const mockSetReplyState = vi.hoisted(() => vi.fn());

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({ getGeneral: mockGetGeneral }),
}));

vi.mock("../services/issue-email-delegations.js", () => ({
  issueEmailDelegationService: () => ({
    transition: mockTransition,
    setReplyState: mockSetReplyState,
  }),
}));

const {
  buildReplyParameters,
  emailHandoffResolutionService,
  replyToolForPlugin,
} = await import("../services/email-handoff-resolution.ts");

const sourceKey = buildEmailHandoffOriginId({
  pluginId: "email-tools",
  mailbox: "personal",
  messageId: "<abc@example.com>",
})!;

const delegation = {
  id: "deleg-1",
  pluginId: "email-tools",
  sourceKey,
  mailbox: "personal",
  status: "resolved",
  version: 1,
};

function makeDispatcher(result: unknown = { data: { ok: true, accepted: ["recipient@example.com"], rejected: [] } }) {
  return {
    getTool: vi.fn(() => ({ parametersSchema: { properties: { messageId: { type: "string" } }, required: ["mailbox", "body"] } })),
    executeTool: vi.fn(async () => ({
      pluginId: "email-tools",
      toolName: "email-tools:email_reply",
      result,
    })),
  } as any;
}

function service(dispatcher: any) {
  return emailHandoffResolutionService({ db: {} as any, dispatcher });
}

const draftedResult = { content: "queued", data: { drafted: true, approvalId: "ap-1" } };

beforeEach(() => {
  vi.clearAllMocks();
  mockTransition.mockResolvedValue(delegation);
  mockSetReplyState.mockResolvedValue(undefined);
  mockGetGeneral.mockResolvedValue({
    outboundToolDraftMode: true,
    emailHandoffReplyApproval: "inherit",
  });
});

describe("email handoff resolution", () => {
  it("resolves the delegation before attempting the reply", async () => {
    const dispatcher = makeDispatcher(draftedResult);
    await service(dispatcher).resolve({
      companyId: "c1",
      delegationId: "deleg-1",
      replyBody: "All sorted, refund issued.",
      actor: {},
    });

    expect(mockTransition).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: "c1", delegationId: "deleg-1", to: "resolved" }),
    );
  });

  it("holds the reply when the setting says always, even with the global hold off", async () => {
    mockGetGeneral.mockResolvedValue({
      outboundToolDraftMode: false,
      emailHandoffReplyApproval: "always",
    });
    const dispatcher = makeDispatcher(draftedResult);

    const { reply } = await service(dispatcher).resolve({
      companyId: "c1",
      delegationId: "deleg-1",
      replyBody: "Done.",
      actor: {},
    });

    expect(reply).toEqual({ replyState: "queued" });
    expect(dispatcher.executeTool).toHaveBeenCalledWith(
      "email-tools:email_reply",
      expect.anything(),
      expect.anything(),
      { legacyActionMode: "ask_first" },
    );
  });

  it("records a confirmed synthetic send when the setting says never, even with the global hold on", async () => {
    mockGetGeneral.mockResolvedValue({
      outboundToolDraftMode: true,
      emailHandoffReplyApproval: "never",
    });
    const dispatcher = makeDispatcher();

    const { reply } = await service(dispatcher).resolve({
      companyId: "c1",
      delegationId: "deleg-1",
      replyBody: "Done.",
      actor: {},
    });

    expect(reply).toEqual({ replyState: "sent" });
    expect(dispatcher.executeTool).toHaveBeenCalledWith(
      "email-tools:email_reply",
      expect.anything(),
      expect.anything(),
      { legacyActionMode: "go_ahead" },
    );
  });

  it("follows the global hold when the setting says inherit", async () => {
    mockGetGeneral.mockResolvedValue({
      outboundToolDraftMode: false,
      emailHandoffReplyApproval: "inherit",
    });
    const dispatcher = makeDispatcher();

    const { reply } = await service(dispatcher).resolve({
      companyId: "c1",
      delegationId: "deleg-1",
      replyBody: "Done.",
      actor: {},
    });

    expect(reply).toEqual({ replyState: "sent" });
    expect(dispatcher.executeTool).toHaveBeenCalledWith(
      "email-tools:email_reply",
      expect.anything(),
      expect.anything(),
      undefined,
    );
  });

  it("holds the reply when the settings cannot be read", async () => {
    mockGetGeneral.mockRejectedValue(new Error("database is down"));
    const dispatcher = makeDispatcher(draftedResult);

    const { reply } = await service(dispatcher).resolve({
      companyId: "c1",
      delegationId: "deleg-1",
      replyBody: "Done.",
      actor: {},
    });

    expect(reply).toEqual({ replyState: "queued" });
    expect(dispatcher.executeTool).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { legacyActionMode: "ask_first" },
    );
  });

  it("records a failed send instead of losing it", async () => {
    const dispatcher = {
      getTool: makeDispatcher().getTool,
      executeTool: vi.fn(async () => {
        throw new Error("Mailbox rejected the message");
      }),
    } as any;

    const { reply } = await service(dispatcher).resolve({
      companyId: "c1",
      delegationId: "deleg-1",
      replyBody: "Done.",
      actor: {},
    });

    expect(reply).toEqual({ replyState: "failed", error: expect.stringContaining("Mailbox rejected the message") });
    expect(mockSetReplyState).toHaveBeenCalledWith(
      expect.objectContaining({
        replyState: "failed",
        replyError: expect.stringContaining("Mailbox rejected the message"),
      }),
    );
  });

  it.each([
    { error: "uid is required" },
    { error: "", data: { ok: true } },
    { failure: { code: "unavailable", message: "Try later" } },
    { isError: true, data: { ok: true } },
    { data: { ok: false } },
    { data: { success: false } },
    { content: "sent" },
    {},
    null,
    { data: { drafted: true } },
    { error: "refused", data: { drafted: true, approvalId: "ap-1" } },
    { data: { ok: true, accepted: [], rejected: [] } },
    { data: { ok: true, accepted: [null], rejected: [] } },
    { data: { ok: true, accepted: ["recipient@example.com"], rejected: ["other@example.com"] } },
    { data: { ok: true, accepted: ["recipient@example.com"], rejected: [], outcome: "unknown" } },
    { data: { ok: true, accepted: ["recipient@example.com"], rejected: [], uncertain: true } },
  ])("never labels a returned failure or uncertain result as sent: %j", async (result) => {
    const dispatcher = makeDispatcher(result);
    const { reply, delegation: resolved } = await service(dispatcher).resolve({
      companyId: "c1", delegationId: "deleg-1", replyBody: "Done.", actor: {},
    });
    expect(reply.replyState).toBe("failed");
    expect(resolved.status).toBe("resolved");
    expect(mockSetReplyState).toHaveBeenCalledWith(expect.objectContaining({ replyState: "failed" }));
    expect(dispatcher.executeTool).toHaveBeenCalledTimes(1);
  });

  it("leaves delivery uncertainty explicit instead of claiming nothing was sent", async () => {
    const { reply } = await service(makeDispatcher({ content: "timeout after SMTP" })).resolve({
      companyId: "c1", delegationId: "deleg-1", replyBody: "Done.", actor: {},
    });
    expect(reply).toMatchObject({ replyState: "failed", error: expect.stringContaining("unknown") });
  });

  it("records confirmed SMTP delivery even when saving the copy or marking the original failed", async () => {
    const { reply } = await service(makeDispatcher({ data: {
      ok: true, accepted: ["recipient@example.com"], rejected: [],
      sent_copy: { ok: false, error: "Synthetic copy failure" }, original_mark: { ok: false, pending: true },
    } })).resolve({ companyId: "c1", delegationId: "deleg-1", replyBody: "Done.", actor: {} });
    expect(reply).toEqual({ replyState: "sent" });
  });

  it.each([0, -1, 1.5, 4_294_967_296])("does not dispatch an invalid UID selector %s", async (uid) => {
    mockTransition.mockResolvedValue({ ...delegation, sourceKey: buildEmailHandoffOriginId({
      pluginId: "email-tools", mailbox: "personal", folder: "INBOX", uid,
    }) });
    const dispatcher = makeDispatcher();
    const { reply } = await service(dispatcher).resolve({
      companyId: "c1", delegationId: "deleg-1", replyBody: "Done.", actor: {},
    });
    expect(reply.replyState).toBe("none");
    expect(dispatcher.executeTool).not.toHaveBeenCalled();
  });

  it("does not dispatch or queue a Message-ID reply to the installed UID-only contract", async () => {
    const dispatcher = makeDispatcher();
    dispatcher.getTool.mockReturnValue({ parametersSchema: {
      properties: { uid: { type: "number" } }, required: ["mailbox", "uid", "body"],
    } });
    const { reply } = await service(dispatcher).resolve({
      companyId: "c1", delegationId: "deleg-1", replyBody: "Done.", actor: {},
    });
    expect(reply).toMatchObject({ replyState: "none", reason: expect.stringContaining("cannot reply by Message-ID") });
    expect(dispatcher.executeTool).not.toHaveBeenCalled();
  });

  it("still uses the UID reply contract for an existing manual UID handoff", async () => {
    mockTransition.mockResolvedValue({ ...delegation, sourceKey: buildEmailHandoffOriginId({
      pluginId: "email-tools", mailbox: "personal", folder: "INBOX", uid: 7,
    }) });
    const dispatcher = makeDispatcher(draftedResult);
    const { reply } = await service(dispatcher).resolve({
      companyId: "c1", delegationId: "deleg-1", replyBody: "Done.", actor: {},
    });
    expect(reply).toEqual({ replyState: "queued" });
    expect(dispatcher.executeTool).toHaveBeenCalledWith("email-tools:email_reply",
      { mailbox: "personal", folder: "INBOX", uid: 7, body: "Done." }, expect.anything(), undefined);
  });

  it("still resolves when the reply fails", async () => {
    const dispatcher = {
      getTool: makeDispatcher().getTool,
      executeTool: vi.fn(async () => {
        throw new Error("nope");
      }),
    } as any;

    // A send that fails must not undo the record that the work was finished.
    const { delegation: resolved } = await service(dispatcher).resolve({
      companyId: "c1",
      delegationId: "deleg-1",
      replyBody: "Done.",
      actor: {},
    });
    expect(resolved.status).toBe("resolved");
  });

  it("resolves without sending when nothing was written", async () => {
    const dispatcher = makeDispatcher();
    const { reply } = await service(dispatcher).resolve({
      companyId: "c1",
      delegationId: "deleg-1",
      replyBody: "   ",
      actor: {},
    });

    expect(reply).toMatchObject({ replyState: "none" });
    expect(dispatcher.executeTool).not.toHaveBeenCalled();
  });

  it("resolves without sending when the plugin has no known reply tool", async () => {
    mockTransition.mockResolvedValue({ ...delegation, pluginId: "some-other-mail-plugin" });
    const dispatcher = makeDispatcher();

    const { reply } = await service(dispatcher).resolve({
      companyId: "c1",
      delegationId: "deleg-1",
      replyBody: "Done.",
      actor: {},
    });

    expect(reply).toMatchObject({ replyState: "none" });
    expect(dispatcher.executeTool).not.toHaveBeenCalled();
  });

  it("resolves without sending when the source key is unreadable", async () => {
    mockTransition.mockResolvedValue({ ...delegation, sourceKey: "garbage" });
    const dispatcher = makeDispatcher();

    const { reply } = await service(dispatcher).resolve({
      companyId: "c1",
      delegationId: "deleg-1",
      replyBody: "Done.",
      actor: {},
    });

    expect(reply).toMatchObject({ replyState: "none" });
    expect(dispatcher.executeTool).not.toHaveBeenCalled();
  });

  it("does not swallow a failed transition", async () => {
    mockTransition.mockRejectedValue(new Error("already resolved"));
    const dispatcher = makeDispatcher();

    await expect(
      service(dispatcher).resolve({
        companyId: "c1",
        delegationId: "deleg-1",
        replyBody: "Done.",
        actor: {},
      }),
    ).rejects.toThrow("already resolved");
    expect(dispatcher.executeTool).not.toHaveBeenCalled();
  });

  it("resolves the reply tool when delegation.pluginId is a plugin UUID", async () => {
    const pluginUuid = "550e8400-e29b-41d4-a716-446655440000";
    const uuidDelegation = {
      ...delegation,
      pluginId: pluginUuid,
    };
    mockTransition.mockResolvedValue(uuidDelegation);

    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ pluginKey: "email-tools" }]),
        }),
      }),
    };

    const dispatcher = makeDispatcher();
    const resolutionSvc = emailHandoffResolutionService({ db: mockDb as any, dispatcher });

    const { reply } = await resolutionSvc.resolve({
      companyId: "c1",
      delegationId: "deleg-1",
      replyBody: "All sorted via IMAP.",
      actor: {},
    });

    expect(reply).toEqual({ replyState: "sent" });
    expect(dispatcher.executeTool).toHaveBeenCalledWith(
      "email-tools:email_reply",
      expect.objectContaining({ body: "All sorted via IMAP." }),
      expect.anything(),
      undefined,
    );
  });
});

describe("replyToolForPlugin", () => {
  it("knows the two providers and refuses to guess at others", () => {
    expect(replyToolForPlugin("email-tools")).toBe("email-tools:email_reply");
    expect(replyToolForPlugin("help-scout")).toBe("help-scout:helpscout_send_reply");
    expect(replyToolForPlugin("something-else")).toBeNull();
  });

  it("resolves tool via optional pluginKeyMap when pluginId is a UUID", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(replyToolForPlugin(uuid, { [uuid]: "email-tools" })).toBe("email-tools:email_reply");
    expect(replyToolForPlugin(uuid)).toBeNull();
  });

  it("names tools that are actually held by the outbound gate", async () => {
    // If a reply tool ever leaves OUTBOUND_TOOL_DRAFT_GATE, "always ask me
    // first" silently stops holding these replies. Fail here rather than in
    // production.
    const { OUTBOUND_TOOL_DRAFT_GATE } = await import("@paperclipai/shared");
    for (const pluginId of ["email-tools", "help-scout"]) {
      expect(OUTBOUND_TOOL_DRAFT_GATE).toContain(replyToolForPlugin(pluginId));
    }
  });
});

describe("buildReplyParameters", () => {
  it("addresses an IMAP reply by message id when it has one", () => {
    expect(
      buildReplyParameters({
        pluginId: "email-tools",
        source: { kind: "msgid", pluginId: "email-tools", mailbox: "personal", messageId: "<a@b>" },
        mailbox: "personal",
        body: "hi",
      }),
    ).toEqual({ mailbox: "personal", messageId: "<a@b>", body: "hi" });
  });

  it("falls back to folder and uid", () => {
    expect(
      buildReplyParameters({
        pluginId: "email-tools",
        source: { kind: "uid", pluginId: "email-tools", mailbox: "personal", folder: "INBOX", uid: 7 },
        mailbox: "personal",
        body: "hi",
      }),
    ).toEqual({ mailbox: "personal", folder: "INBOX", uid: 7, body: "hi" });
  });

  it("will not reply into a Help Scout conversation it cannot name", () => {
    expect(
      buildReplyParameters({
        pluginId: "help-scout",
        source: { kind: "uid", pluginId: "help-scout", mailbox: "support", folder: "x", uid: 1 },
        mailbox: "support",
        body: "hi",
      }),
    ).toBeNull();
  });

  it("refuses an empty body", () => {
    expect(
      buildReplyParameters({
        pluginId: "email-tools",
        source: { kind: "msgid", pluginId: "email-tools", mailbox: "personal", messageId: "<a@b>" },
        mailbox: "personal",
        body: "  ",
      }),
    ).toBeNull();
  });
});
