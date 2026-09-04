/**
 * What happens when an email handoff is finished (P5a §3's option (c)).
 *
 * Barry's decision, 2026-09-03: resolving sends a reply to whoever sent the
 * original email, and whether that reply waits for approval is its own
 * setting rather than being lumped in with every other outbound message.
 *
 * The reply goes out through the SAME plugin tool an agent would use to
 * reply by hand. Nothing here talks to a mail server, and no second approval
 * mechanism is introduced: the existing draft gate does the holding, and this
 * only tells it which way to lean for this particular class of message.
 *
 *   setting "never"   -> bypassDraftGate, sends immediately
 *   setting "always"  -> forceDraftGate, waits even if nothing else does
 *   setting "inherit" -> neither flag, the instance-wide hold decides
 *
 * The delegation is marked resolved BEFORE the reply is attempted, on
 * purpose. Resolution is a fact about the work; the reply is a separate
 * thing that can fail on its own, and a failed send must not silently undo
 * the record that the job was finished. `replyState` carries that outcome
 * so a failure is visible instead of invisible, which is the same shape as
 * the wake-failure fix one layer down.
 */

import type { Db } from "@paperclipai/db";
import {
  emailHandoffReplyNeedsApproval,
  parseEmailHandoffOriginId,
  type EmailHandoffSourceRef,
} from "@paperclipai/shared";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import type { PluginToolDispatcher } from "./plugin-tool-dispatcher.js";
import { instanceSettingsService } from "./instance-settings.js";
import { issueEmailDelegationService } from "./issue-email-delegations.js";
import { logger } from "../middleware/logger.js";

const log = logger.child({ service: "email-handoff-resolution" });

/**
 * Reply tools, by the plugin that owns the source message.
 *
 * A map rather than one generic call because the two providers genuinely
 * differ: Help Scout replies into a conversation, IMAP replies to a message.
 * An unknown plugin resolves the delegation and skips the reply rather than
 * guessing at a tool name, because guessing wrong here means either an error
 * the operator cannot act on or, worse, a message sent through the wrong path.
 */
const REPLY_TOOL_BY_PLUGIN: Record<string, string> = {
  "email-tools": "email-tools:email_reply",
  "help-scout": "help-scout:helpscout_send_reply",
};

export function replyToolForPlugin(pluginId: string): string | null {
  return REPLY_TOOL_BY_PLUGIN[pluginId] ?? null;
}

/**
 * Build the reply tool's parameters from the stored source reference.
 *
 * Returns null when the reference cannot address a reply — a uid-keyed
 * source whose folder is gone, say. The caller treats that as "resolved, no
 * reply sent" rather than an error, because the work really was finished.
 */
export function buildReplyParameters(input: {
  pluginId: string;
  source: EmailHandoffSourceRef;
  mailbox: string;
  body: string;
}): Record<string, unknown> | null {
  const { pluginId, source, mailbox, body } = input;
  if (!body.trim()) return null;

  if (pluginId === "help-scout") {
    if (source.kind !== "msgid") return null;
    return { conversationId: source.messageId, mailbox, text: body };
  }

  if (source.kind === "msgid") {
    return { mailbox, messageId: source.messageId, body };
  }
  return { mailbox, folder: source.folder, uid: source.uid, body };
}

export type ResolveReplyOutcome =
  | { replyState: "none"; reason: string }
  | { replyState: "queued" }
  | { replyState: "sent" }
  | { replyState: "failed"; error: string };

export interface ResolveEmailHandoffInput {
  companyId: string;
  delegationId: string;
  /** The message to send back to whoever sent the original email. */
  replyBody?: string | null;
  resolutionNote?: string | null;
  expectedVersion?: number | null;
  /** Who or what is resolving, for attribution on any approval raised. */
  actor: {
    agentId?: string | null;
    runId?: string | null;
    userId?: string | null;
  };
}

export function emailHandoffResolutionService(deps: {
  db: Db;
  dispatcher: PluginToolDispatcher;
}) {
  const { db, dispatcher } = deps;
  const delegations = issueEmailDelegationService(db);
  const settings = instanceSettingsService(db);

  /**
   * Read the approval policy for these replies.
   *
   * Falls back to requiring approval if settings cannot be read at all. The
   * dangerous direction is sending a message to a customer that the operator
   * expected to see first, so an unreadable setting must not become "send".
   */
  async function replyNeedsApproval(): Promise<boolean> {
    try {
      return emailHandoffReplyNeedsApproval(await settings.getGeneral());
    } catch (err) {
      log.warn({ err }, "could not read reply approval setting; holding the reply for approval");
      return true;
    }
  }

  async function resolve(input: ResolveEmailHandoffInput): Promise<{
    delegation: Awaited<ReturnType<typeof delegations.transition>>;
    reply: ResolveReplyOutcome;
  }> {
    const delegation = await delegations.transition({
      companyId: input.companyId,
      delegationId: input.delegationId,
      to: "resolved",
      resolutionNote: input.resolutionNote,
      expectedVersion: input.expectedVersion,
    });

    const reply = await sendReply({
      companyId: input.companyId,
      delegation,
      replyBody: input.replyBody,
      actor: input.actor,
    });

    try {
      await delegations.setReplyState({
        companyId: input.companyId,
        delegationId: delegation.id,
        replyState: reply.replyState,
        replyError: reply.replyState === "failed" ? reply.error : null,
      });
    } catch (err) {
      // Recording what happened to the reply is bookkeeping. Losing it should
      // not turn a resolution that worked, and possibly a message that has
      // already gone to a customer, into an error the caller retries.
      log.error(
        { err, delegationId: delegation.id, replyState: reply.replyState },
        "could not record the reply outcome; the resolution itself stands",
      );
    }

    return { delegation: { ...delegation, replyState: reply.replyState }, reply };
  }

  async function sendReply(args: {
    companyId: string;
    delegation: { id: string; pluginId: string; sourceKey: string; mailbox: string };
    replyBody?: string | null;
    actor: ResolveEmailHandoffInput["actor"];
  }): Promise<ResolveReplyOutcome> {
    const { companyId, delegation, replyBody, actor } = args;

    const body = replyBody?.trim();
    if (!body) {
      // Resolving without writing anything is legitimate: plenty of handoffs
      // end with an internal answer and nothing to say back.
      return { replyState: "none", reason: "No reply was written." };
    }

    const toolName = replyToolForPlugin(delegation.pluginId);
    if (!toolName) {
      log.warn(
        { pluginId: delegation.pluginId, delegationId: delegation.id },
        "no reply tool known for this plugin; resolved without replying",
      );
      return {
        replyState: "none",
        reason: `No reply tool is known for ${delegation.pluginId}.`,
      };
    }

    const source = parseEmailHandoffOriginId(delegation.sourceKey);
    if (!source) {
      return { replyState: "none", reason: "The original message can no longer be identified." };
    }

    const parameters = buildReplyParameters({
      pluginId: delegation.pluginId,
      source,
      mailbox: delegation.mailbox,
      body,
    });
    if (!parameters) {
      return { replyState: "none", reason: "The original message cannot be replied to." };
    }

    const needsApproval = await replyNeedsApproval();
    // Shaped like the one chat-tools builds. An absent agentId is meaningful
    // rather than missing: the draft gate reads it as "no agent behind this"
    // and attributes any approval it raises to the system and to `userId`,
    // which is what a resolution triggered by a person actually is. runId is
    // only read when an agentId is present, and must stay empty rather than
    // becoming a made-up value, because it is written to a column that
    // references real runs.
    const runContext = {
      companyId,
      agentId: actor.agentId ?? "",
      runId: actor.agentId ? actor.runId ?? "" : "",
      projectId: "",
      userId: actor.userId ?? null,
    } as unknown as ToolRunContext;

    try {
      const execution = await dispatcher.executeTool(toolName, parameters, runContext, {
        // Exactly one of these is ever set. "inherit" sets neither and lets
        // the instance-wide hold decide, which is the default.
        forceDraftGate: needsApproval,
        bypassDraftGate: !needsApproval,
      });

      // The gate returns a synthesized result rather than sending. Detect it
      // by the marker it sets, not by guessing from the text.
      const drafted = Boolean(
        (execution.result as { data?: { drafted?: boolean } } | undefined)?.data?.drafted,
      );
      if (drafted) return { replyState: "queued" };

      if (needsApproval) {
        // Both reply tools are in OUTBOUND_TOOL_DRAFT_GATE, so forcing the
        // gate should always have held this. Reaching here means the tool
        // left that list, and a message the operator expected to review has
        // just gone to a customer. Report it as sent, because it was, and say
        // so loudly rather than recording a comfortable "queued".
        log.error(
          { tool: toolName, delegationId: delegation.id },
          "reply was meant to wait for approval but sent immediately — is this tool still in OUTBOUND_TOOL_DRAFT_GATE?",
        );
      }
      return { replyState: "sent" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        { err, delegationId: delegation.id, tool: toolName },
        "handoff resolution reply failed",
      );
      return { replyState: "failed", error: message };
    }
  }

  return { resolve, replyNeedsApproval };
}

export type EmailHandoffResolutionService = ReturnType<typeof emailHandoffResolutionService>;
