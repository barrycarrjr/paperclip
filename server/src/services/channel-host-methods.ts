/**
 * Host methods for channel plugins (Slack, Teams, SMS): pairing a chat app
 * account to a Paperclip user (`channels.*`), one Clippy turn for that user
 * (`chat.turn`), and an approval decision as that user (`approvals.respond`).
 * The dependencies are injected so the rules can be tested without a
 * database or a model.
 *
 * Who the user is never comes from the plugin. The plugin passes the chat
 * app's identity of whoever sent the message; the host looks up the user
 * who paired that account to themselves from their profile, builds that
 * user's access the way a signed-in request does, and applies the web app's
 * own company access check before doing anything.
 */
import type { Request } from "express";
import { formatByteSize, tooLargeMessage } from "@paperclipai/shared";
import type { WorkerToHostMethods } from "@paperclipai/plugin-sdk/protocol";
import type { ChatActor, StreamEvent } from "./chat.js";
import { createChatTurnCollector } from "./chat-turn-collector.js";
import type { ApprovalDecisionInput, ApprovalDecisionResult } from "./approval-decisions.js";
import type { ChannelIdentity } from "./channel-links.js";
import { WAKE_PROMPT_CONTEXT_KEY } from "./heartbeat.js";
import { assertActorCompanyAccess, hasActorCompanyAccess } from "../routes/authz.js";
import {
  base64Length,
  fileBytesForBase64,
  PLUGIN_MAX_IMAGE_BASE64_BYTES,
  PLUGIN_MAX_IMAGES_BASE64_BYTES,
} from "./plugin-image-limits.js";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";

export type ChannelStartPairingParams = WorkerToHostMethods["channels.startPairing"][0];
export type ChannelStartPairingResult = WorkerToHostMethods["channels.startPairing"][1];
export type ChannelLookupUserParams = WorkerToHostMethods["channels.lookupUser"][0];
export type ChannelLookupUserResult = WorkerToHostMethods["channels.lookupUser"][1];
export type ChatTurnParams = WorkerToHostMethods["chat.turn"][0];
export type ChatTurnResult = WorkerToHostMethods["chat.turn"][1];
export type ApprovalRespondParams = WorkerToHostMethods["approvals.respond"][0];
export type ApprovalRespondResult = WorkerToHostMethods["approvals.respond"][1];

/** Where the pairing code is entered in the web app. */
export const CHANNEL_PROFILE_PATH = "/instance/settings/profile";
/** Same cap the web chat route puts on one message. */
export const MAX_CHANNEL_TEXT_LENGTH = 50_000;
/** Same cap the web chat route puts on attachments per message. */
export const MAX_CHAT_TURN_IMAGES = 8;
/** Image types a chat turn takes: the ones Clippy's providers can show a model. */
const CHAT_TURN_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_DECISION_NOTE_LENGTH = 2_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const NOT_PAIRED_MESSAGE =
  "This chat account is not connected to a Paperclip user yet. Ask the plugin for a pairing code and enter it in your Paperclip profile.";

type BoardActor = Request["actor"];

export interface PendingDraft {
  id: string;
  companyId: string;
  payload: Record<string, unknown>;
}

export interface ChannelHostDeps {
  pluginId: string;
  pluginKey: string;
  links: {
    /** The user paired to this chat account for this plugin, or null. */
    resolveUserId(identity: ChannelIdentity): Promise<string | null>;
    startPairing(identity: ChannelIdentity, label: string | null): { code: string; expiresAt: string };
  };
  /** The user's access, built the way a signed-in request's is; null if the user is gone. */
  boardActorForUser(userId: string): Promise<BoardActor | null>;
  /** Throws when the plugin is not enabled for the company. */
  ensurePluginAvailableForCompany(companyId: string): Promise<void>;
  chat(): {
    getSession(actor: ChatActor, sessionId: string): Promise<{ id: string; companyId: string | null }>;
    createSession(
      actor: ChatActor,
      input: { title?: string; companyId?: string | null; model?: string },
    ): Promise<{ id: string; companyId: string | null }>;
    runTurn(
      actor: ChatActor,
      sessionId: string,
      text: string,
      onAbort?: (cb: () => void) => void,
      attachmentIds?: string[],
    ): AsyncIterable<StreamEvent>;
  };
  /**
   * Stores an image as an attachment of the session, the way the web app's
   * composer uploads one. Throws an HttpError when the attachment rules
   * refuse it.
   */
  storeAttachment(input: {
    sessionId: string;
    userId: string;
    buffer: Buffer;
    mediaType: string;
    name: string;
  }): Promise<{ id: string }>;
  /**
   * Deletes those of a turn's stored images that no message in the session
   * refers to, and returns their ids.
   */
  removeUnusedAttachments(input: { sessionId: string; attachmentIds: string[] }): Promise<string[]>;
  /** Base64 caps on a turn's images; the defaults are the ones `ai.complete` applies. */
  imageLimits?: { perImageBase64Bytes: number; totalBase64Bytes: number };
  /**
   * Claims the session's live-interaction channel for this turn, the one the
   * web app's chat stream uses. Throws while another turn (in the web app or
   * from a chat app) is running in the same session. Returns the release.
   */
  registerInteractions(sessionId: string, emit: (event: StreamEvent) => void): () => void;
  /** Answers a pending confirmation prompt with no. */
  denyConfirmation(sessionId: string, toolUseId: string): void;
  /** Pending outbound drafts queued from this chat session, plus any of `includeIds` still pending. */
  listPendingDrafts(input: { chatSessionId: string; includeIds: string[] }): Promise<PendingDraft[]>;
  getApproval(approvalId: string): Promise<{ id: string; companyId: string; type: string; status: string } | null>;
  decisions: {
    approve(input: ApprovalDecisionInput): Promise<ApprovalDecisionResult>;
    reject(input: ApprovalDecisionInput): Promise<ApprovalDecisionResult>;
  };
  /** Full profile URL when the instance knows its public address, else null. */
  profileUrl(): string | null;
}

/**
 * The run context an `agents.invoke` wake carries. The heartbeat renders the
 * prompt from this key into the agent's task context; using the shared
 * constant keeps the two sides from drifting apart.
 */
export function buildInvokeWakeContext(input: {
  prompt: string;
  reason: string | null | undefined;
  pluginId: string;
  pluginKey: string;
}): Record<string, unknown> {
  return {
    [WAKE_PROMPT_CONTEXT_KEY]: input.prompt,
    wakeReason: input.reason ?? "agent_invoked",
    source: "plugin.agents.invoke",
    pluginId: input.pluginId,
    pluginKey: input.pluginKey,
  };
}

function requireText(value: unknown, name: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isMissingOrForeignSession(err: unknown) {
  return err instanceof HttpError && (err.status === 404 || err.status === 403);
}

/**
 * The image type the bytes themselves show, or null for anything that is not
 * PNG, JPEG, GIF or WebP. A chat app's file can be anything, and an image the
 * model cannot read fails the turn; a provider that re-sends the whole
 * conversation then fails every later turn in the session too.
 */
function imageTypeOf(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const head = bytes.subarray(0, 12).toString("latin1");
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
  return null;
}

type ImageLimits = { perImageBase64Bytes: number; totalBase64Bytes: number };

type CheckedImage =
  | { name: string; bytes: Buffer; mediaType: string; base64Bytes: number }
  | { name: string; reason: string };

/**
 * One image from a chat turn, checked; the reason, in a sentence, when it is
 * left out. `usedBase64Bytes` is what the turn's earlier images take up.
 */
function checkImage(image: unknown, index: number, limits: ImageLimits, usedBase64Bytes: number): CheckedImage {
  const entry = image && typeof image === "object" ? (image as Record<string, unknown>) : {};
  const name = optionalText(entry.name)?.slice(0, 255) ?? `image ${index + 1}`;
  if (index >= MAX_CHAT_TURN_IMAGES) {
    return { name, reason: `Only ${MAX_CHAT_TURN_IMAGES} images can go with one message.` };
  }
  const declared = typeof entry.mediaType === "string" ? entry.mediaType.trim().toLowerCase() : "";
  if (!CHAT_TURN_IMAGE_TYPES.has(declared === "image/jpg" ? "image/jpeg" : declared)) {
    return { name, reason: `${declared || "An image with no type"} is not supported. Send PNG, JPEG, GIF or WebP.` };
  }
  const base64 = typeof entry.base64 === "string" ? entry.base64 : "";
  if (base64.startsWith("data:")) {
    return { name, reason: "Send the image as plain base64, without a data: prefix." };
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0) return { name, reason: "The image is empty." };
  // Sized as the base64 a model's API is sent. A direct API provider resends
  // every image in the conversation on every turn, so one it refuses would
  // fail this turn and each later one in the session.
  const base64Bytes = base64Length(bytes.length);
  if (base64Bytes > limits.perImageBase64Bytes) {
    return { name, reason: tooLargeMessage(bytes.length, fileBytesForBase64(limits.perImageBase64Bytes)) };
  }
  if (usedBase64Bytes + base64Bytes > limits.totalBase64Bytes) {
    const limit = formatByteSize(fileBytesForBase64(limits.totalBase64Bytes));
    return {
      name,
      reason: `With the other images in this message it is over the ${limit} limit for all of them together. Send fewer or smaller images.`,
    };
  }
  const actual = imageTypeOf(bytes);
  if (!actual) return { name, reason: "The data is not a PNG, JPEG, GIF or WebP image." };
  // The bytes decide the type, so a JPEG sent as image/png is shown, not refused.
  return { name, bytes, mediaType: actual, base64Bytes };
}

export function createChannelHostMethods(deps: ChannelHostDeps) {
  async function requirePairedUser(identity: ChannelIdentity | undefined) {
    if (!identity) throw new Error("identity is required");
    const userId = await deps.links.resolveUserId(identity);
    if (!userId) throw new Error(NOT_PAIRED_MESSAGE);
    const actor = await deps.boardActorForUser(userId);
    if (!actor || actor.type !== "board" || !actor.userId) {
      throw new Error("The Paperclip user this chat account was paired to no longer exists");
    }
    return { userId, actor };
  }

  /** The plugin must be enabled there, and the user must be able to make changes there. */
  async function assertCompanyUsable(actor: BoardActor, companyId: string) {
    await deps.ensurePluginAvailableForCompany(companyId);
    // A Clippy turn and an approval decision both change things, so this is
    // the check the web app applies to a signed-in user's POST.
    assertActorCompanyAccess(actor, companyId, "write", "POST");
  }

  async function startPairing(params: ChannelStartPairingParams): Promise<ChannelStartPairingResult> {
    const { code, expiresAt } = deps.links.startPairing(params.identity, optionalText(params.label));
    return { code, expiresAt, profilePath: CHANNEL_PROFILE_PATH, profileUrl: deps.profileUrl() };
  }

  async function lookupUser(params: ChannelLookupUserParams): Promise<ChannelLookupUserResult> {
    const userId = await deps.links.resolveUserId(params.identity);
    if (!userId) return { paired: false, userName: null };
    const actor = await deps.boardActorForUser(userId);
    return actor ? { paired: true, userName: actor.userName ?? null } : { paired: false, userName: null };
  }

  /**
   * Stores a turn's images as attachments of the session, as the web app's
   * composer uploads them, and returns their ids for the turn. An image that
   * breaks a rule is left out with the reason instead of failing the turn:
   * the message itself still goes through.
   */
  async function storeImages(images: unknown, sessionId: string, userId: string) {
    const stored: Array<{ id: string; name: string }> = [];
    const skippedImages: Array<{ name: string; reason: string }> = [];
    const limits = deps.imageLimits ?? {
      perImageBase64Bytes: PLUGIN_MAX_IMAGE_BASE64_BYTES,
      totalBase64Bytes: PLUGIN_MAX_IMAGES_BASE64_BYTES,
    };
    let usedBase64Bytes = 0;
    const list: unknown[] = Array.isArray(images) ? images : [];
    for (const [index, image] of list.entries()) {
      const checked = checkImage(image, index, limits, usedBase64Bytes);
      if ("reason" in checked) {
        skippedImages.push(checked);
        continue;
      }
      try {
        const attachment = await deps.storeAttachment({
          sessionId,
          userId,
          buffer: checked.bytes,
          mediaType: checked.mediaType,
          name: checked.name,
        });
        stored.push({ id: attachment.id, name: checked.name });
        usedBase64Bytes += checked.base64Bytes;
      } catch (err) {
        // The attachment rules can refuse it too: an operator can narrow the
        // allowed types or lower the size limit.
        if (err instanceof HttpError) {
          skippedImages.push({ name: checked.name, reason: err.message });
          continue;
        }
        logger.warn(
          { err, pluginKey: deps.pluginKey, chatSessionId: sessionId },
          "Could not store an image sent with a chat turn; the turn goes without it",
        );
        skippedImages.push({ name: checked.name, reason: "The image could not be stored." });
      }
    }
    return { stored, skippedImages };
  }

  /**
   * Removes the turn's stored images that its message does not refer to: a
   * turn can stop before saving the message (an unknown model, a missing API
   * key), and each retry would otherwise leave another copy on disk. Returns
   * the ones removed. A failure here only costs disk space, so it is logged
   * rather than failing the turn.
   */
  async function removeUnattachedImages(sessionId: string, stored: Array<{ id: string; name: string }>) {
    if (stored.length === 0) return [];
    try {
      const removed = new Set(
        await deps.removeUnusedAttachments({ sessionId, attachmentIds: stored.map((image) => image.id) }),
      );
      return stored.filter((image) => removed.has(image.id));
    } catch (err) {
      logger.warn(
        { err, pluginKey: deps.pluginKey, chatSessionId: sessionId },
        "Could not check for images a chat turn stored but did not attach",
      );
      return [];
    }
  }

  async function chatTurn(params: ChatTurnParams): Promise<ChatTurnResult> {
    const { userId, actor } = await requirePairedUser(params.identity);
    const text = requireText(params.text, "text");
    if (text.length > MAX_CHANNEL_TEXT_LENGTH) {
      throw new Error(`text is longer than ${MAX_CHANNEL_TEXT_LENGTH} characters`);
    }
    const companyId = requireText(params.companyId, "companyId");
    await assertCompanyUsable(actor, companyId);

    const chatActor: ChatActor = {
      userId,
      isInstanceAdmin: actor.isInstanceAdmin === true,
      companyIds: actor.companyIds ?? [],
    };
    const chat = deps.chat();

    // Continue the saved session only while it is still this user's and still
    // scoped to the company that was just checked. One deleted in the app, or
    // re-scoped there, is replaced rather than failing the message.
    let session: { id: string; companyId: string | null } | null = null;
    const requestedSessionId = optionalText(params.sessionId);
    if (requestedSessionId) {
      try {
        const existing = await chat.getSession(chatActor, requestedSessionId);
        if (existing.companyId === companyId) session = existing;
      } catch (err) {
        if (!isMissingOrForeignSession(err)) throw err;
      }
    }
    if (!session) {
      session = await chat.createSession(chatActor, {
        title: optionalText(params.title) ?? "Chat app conversation",
        companyId,
        model: optionalText(params.model) ?? undefined,
      });
    }
    const sessionId = session.id;

    const collector = createChatTurnCollector();
    const onEvent = (event: StreamEvent) => {
      collector.add(event);
      // Nobody can answer a confirmation prompt from a chat app. Answer no
      // at once rather than leave the turn waiting five minutes for a card
      // nobody sees; the reply tells the user where to say yes instead.
      if (event.type === "permission_required") deps.denyConfirmation(sessionId, event.toolUseId);
    };

    // Pending drafts are read before the turn and after it. Either read failing
    // costs only approval buttons, never the turn or its reply: the drafts
    // still wait in the app's approvals list.
    const readPendingDrafts = async (includeIds: string[]): Promise<PendingDraft[] | null> => {
      try {
        return await deps.listPendingDrafts({ chatSessionId: sessionId, includeIds });
      } catch (err) {
        logger.warn(
          { err, pluginKey: deps.pluginKey, chatSessionId: sessionId },
          "Could not read this chat turn's pending drafts; offering fewer approval buttons",
        );
        return null;
      }
    };

    // One turn at a time per session, shared with the web app: this throws
    // while the same conversation is mid-turn in the browser. It also routes
    // tool events from Clippy on the Claude CLI (which reach the server over
    // the MCP bridge, not through the turn's own stream) into this turn.
    const release = deps.registerInteractions(sessionId, onEvent);
    // Null when the drafts already waiting could not be read.
    let alreadyPending: Set<string> | null = null;
    let skippedImages: Array<{ name: string; reason: string }> = [];
    let storedImages: Array<{ id: string; name: string }> = [];
    try {
      const before = await readPendingDrafts([]);
      alreadyPending = before ? new Set(before.map((draft) => draft.id)) : null;
      // Stored only once the session is this turn's, so a message refused
      // because the conversation is busy leaves nothing behind.
      const images = await storeImages(params.images, sessionId, userId);
      skippedImages = images.skippedImages;
      storedImages = images.stored;
      const attachmentIds = storedImages.map((image) => image.id);
      for await (const event of chat.runTurn(chatActor, sessionId, text, undefined, attachmentIds)) onEvent(event);
    } catch (err) {
      collector.fail(err instanceof Error ? err.message : String(err));
    } finally {
      release();
    }
    for (const image of await removeUnattachedImages(sessionId, storedImages)) {
      skippedImages.push({
        name: image.name,
        reason: "The turn stopped before the message was saved, so the image was not kept.",
      });
    }

    const collected = collector.result();
    // Drafts are read back from the database, which sees every draft the turn
    // queued however the tool was reached. A draft that matched one already
    // waiting (or any draft, when those could not be read) is offered only
    // when this turn's own result pointed at it.
    const draftedIds = collected.draftedApprovalIds.filter((id) => UUID_PATTERN.test(id));
    const drafts = (await readPendingDrafts(draftedIds)) ?? [];
    const pendingApprovals = drafts
      .filter((draft) => draftedIds.includes(draft.id) || (alreadyPending !== null && !alreadyPending.has(draft.id)))
      .filter((draft) => hasActorCompanyAccess(actor, draft.companyId, "write", "POST"))
      .map((draft) => ({
        id: draft.id,
        toolName: optionalText(draft.payload.toolName) ?? "tool",
        summary: optionalText(draft.payload.summary),
      }));

    return {
      sessionId,
      replyText: collected.replyText,
      stopReason: collected.stopReason,
      pendingApprovals,
      needsConfirmation: collected.needsConfirmation,
      toolCalls: collected.toolCalls,
      error: collected.error,
      // Always present, so a plugin can tell this host from one that ignores images.
      skippedImages,
    };
  }

  async function approvalsRespond(params: ApprovalRespondParams): Promise<ApprovalRespondResult> {
    const { userId, actor } = await requirePairedUser(params.identity);
    if (params.decision !== "approve" && params.decision !== "reject") {
      throw new Error(`decision must be "approve" or "reject"`);
    }
    const approval = await deps.getApproval(requireText(params.approvalId, "approvalId"));
    if (!approval) throw new Error("Approval not found");
    // The same check the web app's approve and reject routes apply.
    await assertCompanyUsable(actor, approval.companyId);

    const note = optionalText(params.note);
    const input: ApprovalDecisionInput = {
      approvalId: approval.id,
      decidedByUserId: userId,
      decisionNote: note ? note.slice(0, MAX_DECISION_NOTE_LENGTH) : null,
      via: { pluginId: deps.pluginId, pluginKey: deps.pluginKey },
    };
    let result: ApprovalDecisionResult;
    try {
      result = params.decision === "approve" ? await deps.decisions.approve(input) : await deps.decisions.reject(input);
    } catch (err) {
      // Already decided the other way (in the app, or by another button):
      // report how it stands instead of failing the button press.
      if (err instanceof HttpError && err.status === 422) {
        const current = await deps.getApproval(approval.id);
        if (current && current.status !== "pending" && current.status !== "revision_requested") {
          return {
            id: current.id,
            companyId: current.companyId,
            type: current.type,
            status: current.status,
            applied: false,
            executed: null,
          };
        }
      }
      throw err;
    }
    return {
      id: result.approval.id,
      companyId: result.approval.companyId,
      type: result.approval.type,
      status: result.approval.status,
      applied: result.applied,
      executed: result.draftExecution,
    };
  }

  return { startPairing, lookupUser, chatTurn, approvalsRespond };
}
