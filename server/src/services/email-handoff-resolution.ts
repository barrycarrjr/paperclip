/**
 * What happens when an email handoff is finished (P5a §3's option (c)).
 *
 * The operator's decision, 2026-09-03: resolving sends a reply to whoever sent the
 * original email, and whether that reply waits for approval is its own
 * setting rather than being lumped in with every other outbound message.
 *
 * The reply goes out through the SAME plugin tool an agent would use to
 * reply by hand. Nothing here talks to a mail server, and no second approval
 * mechanism is introduced: the existing draft gate does the holding, and this
 * only tells it which way to lean for this particular class of message.
 *
 *   setting "never"   -> legacy go-ahead mode
 *   setting "always"  -> legacy ask-first mode
 *   setting "inherit" -> the instance-wide hold decides
 *
 * An agent or company action policy takes precedence over these older reply
 * settings, so every agent-triggered reply still passes the same checkpoint.
 *
 * The delegation is marked resolved BEFORE the reply is attempted, on
 * purpose. Resolution is a fact about the work; the reply is a separate
 * thing that can fail on its own, and a failed send must not silently undo
 * the record that the job was finished. `replyState` carries that outcome
 * so a failure is visible instead of invisible, which is the same shape as
 * the wake-failure fix one layer down.
 */

import { eq } from "drizzle-orm";
import { plugins, type Db } from "@paperclipai/db";
import {
  emailHandoffReplyNeedsApproval,
  parseEmailHandoffOriginId,
  type AgentActionMode,
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

export function replyToolForPlugin(
  pluginId: string,
  pluginKeyMap?: Record<string, string>,
): string | null {
  const resolvedKey = pluginKeyMap?.[pluginId] ?? pluginId;
  return REPLY_TOOL_BY_PLUGIN[resolvedKey] ?? null;
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

  if (pluginId !== "email-tools") return null;

  if (source.kind === "msgid") {
    return { mailbox, messageId: source.messageId, body };
  }
  if (!source.folder.trim() || /[\x00-\x1f\x7f]/.test(source.folder)
    || !Number.isSafeInteger(source.uid) || source.uid < 1 || source.uid > 4_294_967_295) return null;
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

  async function resolvePluginKey(pluginIdOrKey: string): Promise<string> {
    if (REPLY_TOOL_BY_PLUGIN[pluginIdOrKey]) {
      return pluginIdOrKey;
    }
    if (db && typeof db.select === "function") {
      try {
        const rows = await db
          .select({ pluginKey: plugins.pluginKey })
          .from(plugins)
          .where(eq(plugins.id, pluginIdOrKey));
        if (rows[0]?.pluginKey) {
          return rows[0].pluginKey;
        }
      } catch (err) {
        log.warn({ err, pluginId: pluginIdOrKey }, "failed to resolve plugin key from plugin id");
      }
    }
    return pluginIdOrKey;
  }

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

  async function replyLegacyActionMode(): Promise<AgentActionMode | undefined> {
    try {
      const general = await settings.getGeneral();
      if (general.emailHandoffReplyApproval === "always") return "ask_first";
      if (general.emailHandoffReplyApproval === "never") return "go_ahead";
      return undefined;
    } catch (err) {
      log.warn({ err }, "could not read reply approval setting; holding the reply for approval");
      return "ask_first";
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

    const pluginKey = await resolvePluginKey(delegation.pluginId);
    const toolName = replyToolForPlugin(pluginKey);
    if (!toolName) {
      log.warn(
        { pluginId: delegation.pluginId, pluginKey, delegationId: delegation.id },
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
      pluginId: pluginKey,
      source,
      mailbox: delegation.mailbox,
      body,
    });
    if (!parameters) {
      return { replyState: "none", reason: "The original message cannot be replied to." };
    }

    if (pluginKey === "email-tools" && source.kind === "msgid") {
      // Older Email Tools accepts only a UID. Never guess one, or queue an approval
      // that cannot address the source. The plugin phase must advertise messageId
      // and resolve it to a verified UID in the mailbox before sending.
      const schema = dispatcher.getTool?.(toolName)?.parametersSchema;
      const properties = schema?.properties as Record<string, unknown> | undefined;
      const required = schema?.required;
      if (!properties?.messageId || (Array.isArray(required) && required.includes("uid"))) {
        return { replyState: "none", reason: "Installed Email Tools cannot reply by Message-ID. No reply was attempted." };
      }
    }

    const legacyActionMode = await replyLegacyActionMode();
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
      const execution = await dispatcher.executeTool(
        toolName,
        parameters,
        runContext,
        legacyActionMode ? { legacyActionMode } : undefined,
      );

      const result = execution.result;
      const data = result?.data as Record<string, unknown> | undefined;
      // A returned failure is as real as a thrown one. Failure takes precedence
      // even if a malformed result also claims to have been drafted or sent.
      if (!result || result.error !== undefined || result.failure
        || (result as { isError?: boolean }).isError === true || data?.ok === false
        || data?.success === false) {
        const detail = result?.error || result?.failure?.message;
        return { replyState: "failed", error: `Reply tool reported a failure${detail ? `: ${detail}` : "."} Verify delivery before trying again.` };
      }
      if (data?.drafted === true && typeof data.approvalId === "string" && data.approvalId) {
        return { replyState: "queued" };
      }
      const uncertain = data?.uncertain === true
        || [data?.outcome, data?.status].some((value) => ["uncertain", "unknown", "pending"].includes(String(value)));
      const confirmed = pluginKey === "email-tools"
        ? data?.ok === true && Array.isArray(data.accepted) && data.accepted.length > 0
          && data.accepted.every((address) => typeof address === "string" && address.trim())
          && Array.isArray(data.rejected) && data.rejected.length === 0
        : data?.ok === true;
      if (!uncertain && !data?.drafted && confirmed) return { replyState: "sent" };
      // The existing schema has no unknown state. Keep the uncertainty explicit
      // in replyError, without asserting that no mail was delivered or retrying it.
      return { replyState: "failed", error: "Reply outcome is unknown or incomplete. Verify delivery before trying again." };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        { err, delegationId: delegation.id, tool: toolName },
        "handoff resolution reply failed",
      );
      return { replyState: "failed", error: `Reply attempt did not confirm delivery: ${message}. Verify delivery before trying again.` };
    }
  }

  return { resolve, replyNeedsApproval };
}

export type EmailHandoffResolutionService = ReturnType<typeof emailHandoffResolutionService>;
