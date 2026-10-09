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
import type { WorkerToHostMethods } from "@paperclipai/plugin-sdk/protocol";
import type { ChatActor, StreamEvent } from "./chat.js";
import { createChatTurnCollector } from "./chat-turn-collector.js";
import type { ApprovalDecisionInput, ApprovalDecisionResult } from "./approval-decisions.js";
import type { ChannelIdentity } from "./channel-links.js";
import { WAKE_PROMPT_CONTEXT_KEY } from "./heartbeat.js";
import { assertActorCompanyAccess, hasActorCompanyAccess } from "../routes/authz.js";
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
    runTurn(actor: ChatActor, sessionId: string, text: string): AsyncIterable<StreamEvent>;
  };
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
    try {
      const before = await readPendingDrafts([]);
      alreadyPending = before ? new Set(before.map((draft) => draft.id)) : null;
      for await (const event of chat.runTurn(chatActor, sessionId, text)) onEvent(event);
    } catch (err) {
      collector.fail(err instanceof Error ? err.message : String(err));
    } finally {
      release();
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
