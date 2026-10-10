import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "../services/chat.js";
import { DRAFT_RESULT_HEADER } from "../services/tool-draft-gate.js";
import { WAKE_PROMPT_CONTEXT_KEY } from "../services/heartbeat.js";
import { badRequest, conflict, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import {
  buildInvokeWakeContext,
  CHANNEL_PROFILE_PATH,
  createChannelHostMethods,
  MAX_CHAT_TURN_IMAGES,
  NOT_PAIRED_MESSAGE,
  type ChannelHostDeps,
  type PendingDraft,
} from "../services/channel-host-methods.js";
import { definePlugin } from "../../../packages/plugins/sdk/src/define-plugin.js";
import { startWorkerRpcHost } from "../../../packages/plugins/sdk/src/worker-rpc-host.js";
import {
  createRequest,
  createSuccessResponse,
  isJsonRpcRequest,
  parseMessage,
  serializeMessage,
  type JsonRpcRequest,
} from "../../../packages/plugins/sdk/src/protocol.js";

const USER = "user-pat";
const HQ = "company-hq";
const OTHER = "company-other";
const APPROVAL = "3f1c2b4e-9d8a-4c7b-8e6f-0a1b2c3d4e5f";
const EARLIER_APPROVAL = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const PAT_SLACK = { workspace: "T0001", externalUserId: "U0TESTUSR01" };
const STRANGER_SLACK = { workspace: "T0001", externalUserId: "U0STRANGER" };

// The first bytes of each image type; the host goes by these, not the name.
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const JPEG = Buffer.from("ffd8ffe000104a46494600", "hex");
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
const WEBP = Buffer.from("RIFF\x24\x00\x00\x00WEBPVP8 ", "latin1");

type Actor = Express.Request["actor"];

async function* events(list: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const event of list) yield event;
}

function ownerActor(overrides: Partial<Actor> = {}): Actor {
  return {
    type: "board",
    userId: USER,
    userName: "Pat",
    source: "channel_link",
    companyIds: [HQ],
    memberships: [{ companyId: HQ, membershipRole: "owner", status: "active" }],
    isInstanceAdmin: false,
    ...overrides,
  };
}

function draft(id: string, companyId = HQ): PendingDraft {
  return { id, companyId, payload: { toolName: "email-tools:email_send", summary: "Reply to Jacobs" } };
}

function makeDeps(options: {
  actor?: Actor | null;
  turn?: StreamEvent[] | (() => AsyncIterable<StreamEvent>);
  draftsBefore?: PendingDraft[];
  draftsAfter?: PendingDraft[];
  overrides?: Partial<ChannelHostDeps>;
} = {}) {
  const emitters = new Map<string, (event: StreamEvent) => void>();
  const chat = {
    getSession: vi.fn(async (_actor: unknown, id: string) => ({ id, companyId: HQ as string | null })),
    createSession: vi.fn(async () => ({ id: "s-new", companyId: HQ as string | null })),
    runTurn: vi.fn(() => {
      const turn = options.turn ?? [
        { type: "message_started", messageId: "m1", role: "assistant" },
        { type: "text_delta", delta: "Done: " },
        { type: "text_delta", delta: "two invoices chased." },
        { type: "done", stopReason: "end_turn" },
      ];
      return typeof turn === "function" ? turn() : events(turn);
    }),
  };
  const decisions = {
    approve: vi.fn(async (input: { approvalId: string }) => ({
      approval: { id: input.approvalId, companyId: HQ, type: "outbound_tool_draft", status: "approved" },
      applied: true,
      draftExecution: { ok: true, reason: null, error: null },
    })),
    reject: vi.fn(async (input: { approvalId: string }) => ({
      approval: { id: input.approvalId, companyId: HQ, type: "outbound_tool_draft", status: "rejected" },
      applied: true,
      draftExecution: null,
    })),
  };
  let draftCalls = 0;
  const stored: Array<Parameters<ChannelHostDeps["storeAttachment"]>[0]> = [];
  const deps: ChannelHostDeps = {
    pluginId: "plugin-slack",
    pluginKey: "slack-tools",
    links: {
      resolveUserId: vi.fn(async (identity) => (identity.externalUserId === PAT_SLACK.externalUserId ? USER : null)),
      startPairing: vi.fn(() => ({ code: "K7QF-3MZD", expiresAt: "2026-10-09T10:10:00.000Z" })),
    },
    boardActorForUser: vi.fn(async (userId: string) =>
      userId === USER ? (options.actor === undefined ? ownerActor() : options.actor) : null,
    ),
    ensurePluginAvailableForCompany: vi.fn(async () => undefined),
    chat: () => chat,
    storeAttachment: vi.fn(async (input: Parameters<ChannelHostDeps["storeAttachment"]>[0]) => {
      stored.push(input);
      return { id: `att-${stored.length}` };
    }),
    // The turn saved its message, so nothing it stored is unused.
    removeUnusedAttachments: vi.fn(async () => [] as string[]),
    registerInteractions: vi.fn((sessionId: string, emit: (event: StreamEvent) => void) => {
      if (emitters.has(sessionId)) throw conflict("This conversation already has a running turn");
      emitters.set(sessionId, emit);
      return () => {
        emitters.delete(sessionId);
      };
    }),
    denyConfirmation: vi.fn(),
    listPendingDrafts: vi.fn(async () => {
      draftCalls += 1;
      return draftCalls === 1 ? (options.draftsBefore ?? []) : (options.draftsAfter ?? []);
    }),
    getApproval: vi.fn(async (id: string) =>
      id === APPROVAL ? { id, companyId: HQ, type: "outbound_tool_draft", status: "pending" } : null,
    ),
    decisions: decisions as unknown as ChannelHostDeps["decisions"],
    profileUrl: () => null,
    ...options.overrides,
  };
  return { deps, chat, decisions, emitters, stored };
}

describe("channels pairing", () => {
  it("hands out a code with where to enter it", async () => {
    const { deps } = makeDeps();
    const methods = createChannelHostMethods(deps);
    const result = await methods.startPairing({ identity: STRANGER_SLACK, label: "  Alex  " });
    expect(deps.links.startPairing).toHaveBeenCalledWith(STRANGER_SLACK, "Alex");
    expect(result).toEqual({
      code: "K7QF-3MZD",
      expiresAt: "2026-10-09T10:10:00.000Z",
      profilePath: CHANNEL_PROFILE_PATH,
      profileUrl: null,
    });
  });

  it("says whether a chat account is paired, and to whom", async () => {
    const methods = createChannelHostMethods(makeDeps().deps);
    expect(await methods.lookupUser({ identity: PAT_SLACK })).toEqual({ paired: true, userName: "Pat" });
    expect(await methods.lookupUser({ identity: STRANGER_SLACK })).toEqual({ paired: false, userName: null });
  });
});

describe("chat.turn", () => {
  it("runs the turn as the paired user, in a new session scoped to the company", async () => {
    const { deps, chat } = makeDeps();
    const methods = createChannelHostMethods(deps);
    const result = await methods.chatTurn({ identity: PAT_SLACK, companyId: HQ, text: "chase the invoices", title: "Slack DM" });
    expect(chat.createSession).toHaveBeenCalledWith(
      { userId: USER, isInstanceAdmin: false, companyIds: [HQ] },
      { title: "Slack DM", companyId: HQ, model: undefined },
    );
    expect(chat.runTurn).toHaveBeenCalledWith(expect.objectContaining({ userId: USER }), "s-new", "chase the invoices", undefined, []);
    expect(result).toEqual({
      sessionId: "s-new",
      replyText: "Done: two invoices chased.",
      stopReason: "end_turn",
      pendingApprovals: [],
      needsConfirmation: [],
      toolCalls: [],
      error: null,
      skippedImages: [],
    });
  });

  it("refuses a chat account nobody has paired", async () => {
    const { deps, chat } = makeDeps();
    const methods = createChannelHostMethods(deps);
    await expect(methods.chatTurn({ identity: STRANGER_SLACK, companyId: HQ, text: "hi" })).rejects.toThrow(NOT_PAIRED_MESSAGE);
    expect(chat.runTurn).not.toHaveBeenCalled();
  });

  it("refuses a company the user cannot make changes in, with the web app's own check", async () => {
    const viewer = ownerActor({ memberships: [{ companyId: HQ, membershipRole: "viewer", status: "active" }] });
    for (const [actor, companyId, message] of [
      [ownerActor(), OTHER, "User does not have access to this company"],
      [viewer, HQ, "Viewer access is read-only"],
      [ownerActor({ isInstanceAdmin: true, companyIds: [], memberships: [] }), OTHER, "User does not have access"],
      [ownerActor({ isPortfolioRootUserAdmin: true }), OTHER, "User does not have access to this company"],
    ] as const) {
      const { deps, chat } = makeDeps({ actor });
      const methods = createChannelHostMethods(deps);
      await expect(methods.chatTurn({ identity: PAT_SLACK, companyId, text: "hi" })).rejects.toThrow(message);
      expect(chat.runTurn).not.toHaveBeenCalled();
    }
  });

  it("continues a saved session, and replaces one that is gone or scoped elsewhere", async () => {
    const kept = makeDeps();
    const keptResult = await createChannelHostMethods(kept.deps).chatTurn({
      identity: PAT_SLACK, companyId: HQ, sessionId: "s-existing", text: "and the third?",
    });
    expect(keptResult.sessionId).toBe("s-existing");
    expect(kept.chat.createSession).not.toHaveBeenCalled();

    const gone = makeDeps();
    gone.chat.getSession.mockRejectedValueOnce(notFound("Chat session s-gone not found"));
    const goneResult = await createChannelHostMethods(gone.deps).chatTurn({
      identity: PAT_SLACK, companyId: HQ, sessionId: "s-gone", text: "hello again",
    });
    expect(goneResult.sessionId).toBe("s-new");

    const moved = makeDeps();
    moved.chat.getSession.mockResolvedValueOnce({ id: "s-moved", companyId: OTHER });
    const movedResult = await createChannelHostMethods(moved.deps).chatTurn({
      identity: PAT_SLACK, companyId: HQ, sessionId: "s-moved", text: "hello again",
    });
    expect(movedResult.sessionId).toBe("s-new");
  });

  it("refuses a second turn while the conversation is mid-turn, in the app or another chat", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps } = makeDeps({
      turn: async function* () {
        await gate;
        yield { type: "done", stopReason: "end_turn" } as StreamEvent;
      },
    });
    const methods = createChannelHostMethods(deps);
    const first = methods.chatTurn({ identity: PAT_SLACK, companyId: HQ, sessionId: "s-busy", text: "one" });
    await vi.waitFor(() => expect(deps.registerInteractions).toHaveBeenCalledTimes(1));
    await expect(
      methods.chatTurn({ identity: PAT_SLACK, companyId: HQ, sessionId: "s-busy", text: "two" }),
    ).rejects.toThrow("already has a running turn");
    release();
    await expect(first).resolves.toMatchObject({ sessionId: "s-busy" });
    // Released afterwards, so the next message runs.
    await expect(
      methods.chatTurn({ identity: PAT_SLACK, companyId: HQ, sessionId: "s-busy", text: "three" }),
    ).resolves.toMatchObject({ sessionId: "s-busy" });
  });

  it("collects tool events reported over the live channel, as Clippy on the Claude CLI sends them", async () => {
    let emitters!: Map<string, (event: StreamEvent) => void>;
    const made = makeDeps({
      turn: async function* () {
        // What the MCP bridge does while the CLI turn is running.
        const emit = emitters.get("s-new")!;
        emit({ type: "tool_use_block", toolUseId: "plugin-1", name: "email-tools__email_send", input: {}, mutating: true });
        emit({
          type: "tool_result_block",
          toolUseId: "plugin-1",
          ok: true,
          result: { drafted: true, approvalId: APPROVAL, status: "pending" },
        });
        yield { type: "text_delta", delta: "Drafted the reply; it needs your OK." } as StreamEvent;
        yield { type: "done", stopReason: "end_turn" } as StreamEvent;
      },
      draftsAfter: [draft(APPROVAL)],
    });
    emitters = made.emitters;
    const result = await createChannelHostMethods(made.deps).chatTurn({ identity: PAT_SLACK, companyId: HQ, text: "reply to Jacobs" });
    expect(result.toolCalls).toEqual([{ name: "email-tools__email_send", ok: true }]);
    expect(result.pendingApprovals).toEqual([{ id: APPROVAL, toolName: "email-tools:email_send", summary: "Reply to Jacobs" }]);
  });

  it("offers the drafts this turn queued, not ones already waiting from before", async () => {
    const { deps } = makeDeps({
      draftsBefore: [draft(EARLIER_APPROVAL)],
      draftsAfter: [draft(EARLIER_APPROVAL), draft(APPROVAL)],
    });
    const result = await createChannelHostMethods(deps).chatTurn({ identity: PAT_SLACK, companyId: HQ, text: "send it" });
    expect(result.pendingApprovals.map((item) => item.id)).toEqual([APPROVAL]);
  });

  it("offers an earlier draft again when this turn's own result points at it", async () => {
    const { deps } = makeDeps({
      turn: [
        { type: "tool_use_block", toolUseId: "t1", name: "email-tools__email_send", input: {}, mutating: true },
        {
          type: "tool_result_block",
          toolUseId: "t1",
          ok: true,
          result: `${DRAFT_RESULT_HEADER}\nApproval ID: ${EARLIER_APPROVAL}\n`,
        },
        { type: "done", stopReason: "tool_drafted" },
      ],
      draftsBefore: [draft(EARLIER_APPROVAL)],
      draftsAfter: [draft(EARLIER_APPROVAL)],
    });
    const result = await createChannelHostMethods(deps).chatTurn({ identity: PAT_SLACK, companyId: HQ, text: "send it" });
    expect(result.pendingApprovals.map((item) => item.id)).toEqual([EARLIER_APPROVAL]);
    expect(deps.listPendingDrafts).toHaveBeenLastCalledWith({ chatSessionId: "s-new", includeIds: [EARLIER_APPROVAL] });
  });

  it("leaves out drafts the user could not decide", async () => {
    const { deps } = makeDeps({ draftsAfter: [draft(APPROVAL, OTHER)] });
    const result = await createChannelHostMethods(deps).chatTurn({ identity: PAT_SLACK, companyId: HQ, text: "send it" });
    expect(result.pendingApprovals).toEqual([]);
  });

  it("answers a confirmation prompt with no at once and reports it", async () => {
    const { deps } = makeDeps({
      turn: [
        { type: "tool_use_block", toolUseId: "t1", name: "create_issue", input: {}, mutating: true },
        { type: "permission_required", toolUseId: "t1", name: "create_issue", input: {}, ttlMs: 300_000 },
        { type: "tool_result_block", toolUseId: "t1", ok: false, result: { error: "User denied this action." } },
        { type: "text_delta", delta: "I could not create it." },
        { type: "done", stopReason: "end_turn" },
      ],
    });
    const result = await createChannelHostMethods(deps).chatTurn({ identity: PAT_SLACK, companyId: HQ, text: "make an issue" });
    expect(deps.denyConfirmation).toHaveBeenCalledWith("s-new", "t1");
    expect(result.needsConfirmation).toEqual(["create_issue"]);
  });

  it("keeps the session id when the turn fails part way, so the next message continues it", async () => {
    const { deps } = makeDeps({
      turn: async function* () {
        yield { type: "text_delta", delta: "Working on" } as StreamEvent;
        throw new Error("provider went away");
      },
    });
    const result = await createChannelHostMethods(deps).chatTurn({ identity: PAT_SLACK, companyId: HQ, text: "go" });
    expect(result).toMatchObject({ sessionId: "s-new", error: "provider went away", replyText: "Working on" });
  });

  it("still sends the reply when the drafts cannot be read after the turn", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      const { deps } = makeDeps({
        overrides: {
          listPendingDrafts: vi
            .fn()
            .mockResolvedValueOnce([])
            .mockRejectedValueOnce(new Error("connection terminated")),
        },
      });
      const result = await createChannelHostMethods(deps).chatTurn({ identity: PAT_SLACK, companyId: HQ, text: "chase them" });
      expect(result).toMatchObject({
        sessionId: "s-new",
        replyText: "Done: two invoices chased.",
        pendingApprovals: [],
        error: null,
      });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ chatSessionId: "s-new" }),
        expect.stringContaining("pending drafts"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("still runs the turn when the drafts cannot be read before it, offering only drafts the turn reports", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      const { deps, chat } = makeDeps({
        turn: [
          { type: "tool_use_block", toolUseId: "t1", name: "email-tools__email_send", input: {}, mutating: true },
          { type: "tool_result_block", toolUseId: "t1", ok: true, result: `${DRAFT_RESULT_HEADER}\nApproval ID: ${APPROVAL}\n` },
          { type: "text_delta", delta: "Drafted the reply." },
          { type: "done", stopReason: "tool_drafted" },
        ],
        overrides: {
          listPendingDrafts: vi
            .fn()
            .mockRejectedValueOnce(new Error("connection terminated"))
            .mockResolvedValueOnce([draft(EARLIER_APPROVAL), draft(APPROVAL)]),
        },
      });
      const result = await createChannelHostMethods(deps).chatTurn({ identity: PAT_SLACK, companyId: HQ, text: "reply to Jacobs" });
      expect(chat.runTurn).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ replyText: "Drafted the reply.", error: null });
      // Which drafts were already waiting is unknown, so the earlier one is not offered again.
      expect(result.pendingApprovals.map((item) => item.id)).toEqual([APPROVAL]);
    } finally {
      warn.mockRestore();
    }
  });

  it("requires text and caps its length", async () => {
    const methods = createChannelHostMethods(makeDeps().deps);
    await expect(methods.chatTurn({ identity: PAT_SLACK, companyId: HQ, text: "   " })).rejects.toThrow("text is required");
    await expect(methods.chatTurn({ identity: PAT_SLACK, companyId: HQ, text: "x".repeat(50_001) })).rejects.toThrow(
      "longer than",
    );
  });
});

describe("chat.turn images", () => {
  const image = (name: string | undefined, mediaType: string, bytes: Buffer | string) => ({
    ...(name ? { name } : {}),
    mediaType,
    base64: typeof bytes === "string" ? bytes : bytes.toString("base64"),
  });

  it("stores each image as an attachment of the session and sends it with the message, as the composer does", async () => {
    const { deps, chat, stored } = makeDeps();
    const result = await createChannelHostMethods(deps).chatTurn({
      identity: PAT_SLACK,
      companyId: HQ,
      text: "what is this error?",
      images: [
        image("screenshot.png", "image/png", PNG),
        // The bytes decide the type: a JPEG sent as a PNG is stored as a JPEG.
        image("photo.png", "image/png", JPEG),
        image(undefined, "image/gif", GIF),
        image("sticker.webp", "image/webp", WEBP),
      ],
    });

    expect(stored.map(({ sessionId, userId, mediaType, name }) => ({ sessionId, userId, mediaType, name }))).toEqual([
      { sessionId: "s-new", userId: USER, mediaType: "image/png", name: "screenshot.png" },
      { sessionId: "s-new", userId: USER, mediaType: "image/jpeg", name: "photo.png" },
      { sessionId: "s-new", userId: USER, mediaType: "image/gif", name: "image 3" },
      { sessionId: "s-new", userId: USER, mediaType: "image/webp", name: "sticker.webp" },
    ]);
    expect(stored[0]!.buffer.equals(PNG)).toBe(true);
    expect(chat.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER }),
      "s-new",
      "what is this error?",
      undefined,
      ["att-1", "att-2", "att-3", "att-4"],
    );
    expect(result).toMatchObject({ replyText: "Done: two invoices chased.", error: null, skippedImages: [] });
  });

  it("leaves out each image that breaks a rule, says why, and still runs the turn", async () => {
    // As base64, PNG takes 24 bytes and JPEG 16. These caps stand in for 10 MB
    // an image and 24 MB a turn: 40 allows a 30 byte file, 60 all of them.
    const { deps, chat, stored } = makeDeps({
      overrides: { imageLimits: { perImageBase64Bytes: 40, totalBase64Bytes: 60 } },
    });
    const result = await createChannelHostMethods(deps).chatTurn({
      identity: PAT_SLACK,
      companyId: HQ,
      text: "look at these",
      images: [
        image("ok.png", "image/png", PNG),
        image("photo.heic", "image/heic", PNG),
        image("inline.png", "image/png", `data:image/png;base64,${PNG.toString("base64")}`),
        image("notes.png", "image/png", Buffer.from("not an image at all")),
        image("empty.png", "image/png", ""),
        image("huge.png", "image/png", Buffer.concat([PNG, Buffer.alloc(100)])),
        image("more.jpg", "image/jpg", JPEG),
        image("one-too-many.png", "image/png", PNG),
        image("ninth.png", "image/png", PNG),
        image("tenth.png", "image/png", PNG),
      ],
    });

    expect(stored.map((entry) => entry.name)).toEqual(["ok.png", "more.jpg"]);
    expect(chat.runTurn).toHaveBeenCalledWith(expect.anything(), "s-new", "look at these", undefined, ["att-1", "att-2"]);
    expect(result.skippedImages).toEqual([
      { name: "photo.heic", reason: "image/heic is not supported. Send PNG, JPEG, GIF or WebP." },
      { name: "inline.png", reason: "Send the image as plain base64, without a data: prefix." },
      { name: "notes.png", reason: "The data is not a PNG, JPEG, GIF or WebP image." },
      { name: "empty.png", reason: "The image is empty." },
      { name: "huge.png", reason: "File is 116 B, which is over the 30 B limit. Compress it or trim it down and try again." },
      {
        name: "one-too-many.png",
        reason: "With the other images in this message it is over the 45 B limit for all of them together. Send fewer or smaller images.",
      },
      { name: "ninth.png", reason: `Only ${MAX_CHAT_TURN_IMAGES} images can go with one message.` },
      { name: "tenth.png", reason: `Only ${MAX_CHAT_TURN_IMAGES} images can go with one message.` },
    ]);
    expect(result).toMatchObject({ replyText: "Done: two invoices chased.", error: null });
  });

  it("caps images at the sizes ai.complete takes: 10 MB of base64 for one, 24 MB for a turn's", async () => {
    // 7.5 MB of file is exactly 10 MB of base64; one byte more is over.
    const FULL = 7.5 * 1024 * 1024;
    const padded = (bytes: number) => Buffer.concat([PNG, Buffer.alloc(bytes - PNG.length)]);
    const { deps, stored } = makeDeps();
    const result = await createChannelHostMethods(deps).chatTurn({
      identity: PAT_SLACK,
      companyId: HQ,
      text: "big screenshots",
      images: [
        image("first.png", "image/png", padded(FULL)),
        image("over.png", "image/png", padded(FULL + 1)),
        image("second.png", "image/png", padded(FULL)),
        image("third.png", "image/png", padded(FULL)),
        // 20 MB of the 24 are taken, and a small one still fits.
        image("small.png", "image/png", padded(1024)),
      ],
    });

    expect(stored.map((entry) => entry.name)).toEqual(["first.png", "second.png", "small.png"]);
    expect(result.skippedImages).toEqual([
      { name: "over.png", reason: "File is 7.5 MB, which is over the 7.5 MB limit. Compress it or trim it down and try again." },
      {
        name: "third.png",
        reason: "With the other images in this message it is over the 18.0 MB limit for all of them together. Send fewer or smaller images.",
      },
    ]);
  });

  it("removes the images it stored when the turn stops before saving the message, and says so", async () => {
    const { deps, stored } = makeDeps({
      turn: [{ type: "error", error: 'No provider supports model "retired-model".', code: "unsupported_model" }],
      // What the attachment service finds after such a turn: no message refers to them.
      overrides: { removeUnusedAttachments: vi.fn(async ({ attachmentIds }: { attachmentIds: string[] }) => attachmentIds) },
    });
    const result = await createChannelHostMethods(deps).chatTurn({
      identity: PAT_SLACK,
      companyId: HQ,
      text: "what is this?",
      images: [image("a.png", "image/png", PNG), image("b.gif", "image/gif", GIF)],
    });

    expect(stored).toHaveLength(2);
    expect(deps.removeUnusedAttachments).toHaveBeenCalledWith({ sessionId: "s-new", attachmentIds: ["att-1", "att-2"] });
    const reason = "The turn stopped before the message was saved, so the image was not kept.";
    expect(result.skippedImages).toEqual([
      { name: "a.png", reason },
      { name: "b.gif", reason },
    ]);
    expect(result.error).toBe('No provider supports model "retired-model".');
  });

  it("still answers when the unused images cannot be checked", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      const { deps } = makeDeps({
        overrides: { removeUnusedAttachments: vi.fn().mockRejectedValue(new Error("connection terminated")) },
      });
      const result = await createChannelHostMethods(deps).chatTurn({
        identity: PAT_SLACK,
        companyId: HQ,
        text: "see attached",
        images: [image("a.png", "image/png", PNG)],
      });

      expect(result).toMatchObject({ replyText: "Done: two invoices chased.", error: null, skippedImages: [] });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ chatSessionId: "s-new" }),
        expect.stringContaining("did not attach"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("leaves out an image the attachment rules refuse, or that cannot be stored, without failing the turn", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      const { deps, chat } = makeDeps({
        overrides: {
          storeAttachment: vi
            .fn()
            .mockRejectedValueOnce(badRequest("Unsupported attachment type: image/png"))
            .mockRejectedValueOnce(new Error("ENOSPC: no space left on device")),
        },
      });
      const result = await createChannelHostMethods(deps).chatTurn({
        identity: PAT_SLACK,
        companyId: HQ,
        text: "see attached",
        images: [image("a.png", "image/png", PNG), image("b.png", "image/png", PNG)],
      });

      expect(result.skippedImages).toEqual([
        { name: "a.png", reason: "Unsupported attachment type: image/png" },
        { name: "b.png", reason: "The image could not be stored." },
      ]);
      expect(chat.runTurn).toHaveBeenCalledWith(expect.anything(), "s-new", "see attached", undefined, []);
      expect(result).toMatchObject({ replyText: "Done: two invoices chased.", error: null });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ chatSessionId: "s-new" }),
        expect.stringContaining("Could not store an image"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("stores nothing when the conversation is busy and the message is refused", async () => {
    const { deps, stored } = makeDeps({
      overrides: {
        registerInteractions: vi.fn(() => {
          throw conflict("This conversation already has a running turn");
        }),
      },
    });
    await expect(
      createChannelHostMethods(deps).chatTurn({
        identity: PAT_SLACK,
        companyId: HQ,
        sessionId: "s-busy",
        text: "and this one",
        images: [image("a.png", "image/png", PNG)],
      }),
    ).rejects.toThrow("already has a running turn");
    expect(stored).toEqual([]);
  });
});

describe("chat.turn from a real plugin worker", () => {
  it("carries the plugin's images to the host", async () => {
    // The test harness hands ctx.chat.turn its input as it is, but the worker
    // that ships builds the host call field by field, and a field it leaves
    // out never reaches the host. This drives that worker over streams.
    const images = [{ name: "screenshot.png", mediaType: "image/png", base64: PNG.toString("base64") }];
    const plugin = definePlugin({
      async setup(ctx) {
        ctx.actions.register("send", async () =>
          ctx.chat.turn({ identity: PAT_SLACK, companyId: HQ, text: "what is this?", images }),
        );
      },
    });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const host = startWorkerRpcHost({ plugin, stdin, stdout });
    const messages: unknown[] = [];
    stdout.on("data", (chunk) => {
      for (const line of String(chunk).split("\n").filter(Boolean)) messages.push(parseMessage(line));
    });
    const answered = (id: number) => messages.some((message) => (message as { id?: unknown }).id === id && !isJsonRpcRequest(message));

    try {
      stdin.write(
        serializeMessage(
          createRequest(
            "initialize",
            {
              manifest: {
                id: "paperclip.test-chat-images",
                apiVersion: 1,
                version: "0.1.0",
                displayName: "Test chat images",
                description: "Test plugin",
                author: "Paperclip",
                categories: ["automation"],
                capabilities: ["chat.turn"],
                entrypoints: { worker: "./dist/worker.js" },
              },
              config: {},
              instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
              apiVersion: 1,
            },
            1,
          ),
        ),
      );
      await vi.waitFor(() => expect(answered(1)).toBe(true));

      stdin.write(serializeMessage(createRequest("performAction", { key: "send", params: {} }, 2)));
      const call = await vi.waitFor(() => {
        const found = messages.find((message) => isJsonRpcRequest(message) && message.method === "chat.turn");
        expect(found).toBeDefined();
        return found as JsonRpcRequest;
      });
      expect((call.params as { images?: unknown }).images).toEqual(images);

      // Answer the call so the action finishes.
      stdin.write(
        serializeMessage(
          createSuccessResponse(call.id, {
            sessionId: "s-new",
            replyText: "It is a stack trace.",
            stopReason: "end_turn",
            pendingApprovals: [],
            needsConfirmation: [],
            toolCalls: [],
            error: null,
            skippedImages: [],
          }),
        ),
      );
      await vi.waitFor(() => expect(answered(2)).toBe(true));
    } finally {
      host.stop();
    }
  });
});

describe("approvals.respond", () => {
  it("decides as the paired user and says which plugin it came through", async () => {
    const { deps, decisions } = makeDeps();
    const methods = createChannelHostMethods(deps);
    const result = await methods.approvalsRespond({ identity: PAT_SLACK, approvalId: APPROVAL, decision: "approve" });
    expect(decisions.approve).toHaveBeenCalledWith({
      approvalId: APPROVAL,
      decidedByUserId: USER,
      decisionNote: null,
      via: { pluginId: "plugin-slack", pluginKey: "slack-tools" },
    });
    expect(result).toEqual({
      id: APPROVAL,
      companyId: HQ,
      type: "outbound_tool_draft",
      status: "approved",
      applied: true,
      executed: { ok: true, reason: null, error: null },
    });

    await methods.approvalsRespond({ identity: PAT_SLACK, approvalId: APPROVAL, decision: "reject", note: "not now" });
    expect(decisions.reject).toHaveBeenCalledWith(expect.objectContaining({ decisionNote: "not now" }));
  });

  it("refuses anything but approve or reject", async () => {
    const { deps, decisions } = makeDeps();
    const methods = createChannelHostMethods(deps);
    await expect(
      methods.approvalsRespond({ identity: PAT_SLACK, approvalId: APPROVAL, decision: "maybe" as "approve" }),
    ).rejects.toThrow('decision must be "approve" or "reject"');
    expect(decisions.approve).not.toHaveBeenCalled();
    expect(decisions.reject).not.toHaveBeenCalled();
  });

  it("refuses an unpaired account, and a user the web app would refuse", async () => {
    const stranger = makeDeps();
    await expect(
      createChannelHostMethods(stranger.deps).approvalsRespond({ identity: STRANGER_SLACK, approvalId: APPROVAL, decision: "approve" }),
    ).rejects.toThrow(NOT_PAIRED_MESSAGE);

    // An instance admin with no membership in the approval's company: the
    // web app's approve route refuses them, so a Slack button must too.
    const admin = makeDeps({ actor: ownerActor({ isInstanceAdmin: true, companyIds: [], memberships: [] }) });
    await expect(
      createChannelHostMethods(admin.deps).approvalsRespond({ identity: PAT_SLACK, approvalId: APPROVAL, decision: "approve" }),
    ).rejects.toThrow("User does not have access to this company");
    expect(admin.decisions.approve).not.toHaveBeenCalled();

    const viewer = makeDeps({
      actor: ownerActor({ memberships: [{ companyId: HQ, membershipRole: "viewer", status: "active" }] }),
    });
    await expect(
      createChannelHostMethods(viewer.deps).approvalsRespond({ identity: PAT_SLACK, approvalId: APPROVAL, decision: "approve" }),
    ).rejects.toThrow("Viewer access is read-only");
  });

  it("reports an approval already decided the other way instead of failing", async () => {
    const { deps, decisions } = makeDeps();
    decisions.approve.mockRejectedValueOnce(unprocessable("Only pending or revision requested approvals can be approved"));
    deps.getApproval = vi
      .fn()
      .mockResolvedValueOnce({ id: APPROVAL, companyId: HQ, type: "outbound_tool_draft", status: "pending" })
      .mockResolvedValueOnce({ id: APPROVAL, companyId: HQ, type: "outbound_tool_draft", status: "rejected" });
    const result = await createChannelHostMethods(deps).approvalsRespond({
      identity: PAT_SLACK, approvalId: APPROVAL, decision: "approve",
    });
    expect(result).toMatchObject({ status: "rejected", applied: false, executed: null });
  });

  it("refuses an approval that does not exist", async () => {
    const methods = createChannelHostMethods(makeDeps().deps);
    await expect(
      methods.approvalsRespond({ identity: PAT_SLACK, approvalId: "00000000-0000-4000-8000-000000000000", decision: "approve" }),
    ).rejects.toThrow("Approval not found");
  });
});

describe("buildInvokeWakeContext", () => {
  it("puts the prompt under the key the heartbeat renders", () => {
    const context = buildInvokeWakeContext({ prompt: "Slack DM: pay the tuner", reason: null, pluginId: "p1", pluginKey: "slack-tools" });
    expect(context[WAKE_PROMPT_CONTEXT_KEY]).toBe("Slack DM: pay the tuner");
    expect(context.wakeReason).toBe("agent_invoked");
  });
});
