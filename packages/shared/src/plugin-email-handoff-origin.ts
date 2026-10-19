import { buildEmailHandoffOriginId, parseEmailHandoffOriginId } from "./email-handoff-origin.js";

/** The installed Email Tools worker is trusted to validate routing policy and message provenance. */
export const EMAIL_HANDOFF_PLUGIN_KEY = "email-tools";

/** Strict write-side validation, without changing the forgiving parser used for historical records. */
export function canonicalizePluginEmailHandoffOrigin(input: {
  pluginKey: string;
  pluginId: string;
  originId: unknown;
  assigneeAgentId: unknown;
  assigneeUserId?: unknown;
}) {
  if (input.pluginKey !== EMAIL_HANDOFF_PLUGIN_KEY) {
    throw new Error("Only Email Tools may create plugin email handoffs");
  }
  if (typeof input.assigneeAgentId !== "string" || !input.assigneeAgentId.trim() || input.assigneeUserId) {
    throw new Error("Email handoffs require one assigned agent");
  }
  if (typeof input.originId !== "string" || input.originId.length > 4096) {
    throw new Error("Email handoffs require a valid source originId");
  }
  // The historical parser tolerates broken percent escapes. New writes must not.
  try {
    input.originId.split(":").forEach((part) => decodeURIComponent(part));
  } catch {
    throw new Error("Email handoffs require a valid source originId");
  }
  const source = parseEmailHandoffOriginId(input.originId);
  if (!source || (source.pluginId !== input.pluginKey && source.pluginId !== input.pluginId)) {
    throw new Error("Email handoff source must name the calling plugin");
  }
  // UID-only keys lack UIDVALIDITY and can name a different message after a mailbox reset.
  // Routing must wait for operator review when there is no stable Message-ID.
  if (source.kind !== "msgid") {
    throw new Error("Plugin email handoffs require a stable Message-ID; UID-only sources are unsupported");
  }
  if (!/^[^\s\x00-\x1f\x7f]{1,200}$/.test(source.mailbox)
    || source.messageId.length > 998
    || !/^<[^<>\s\x00-\x1f\x7f@]+@[^<>\s\x00-\x1f\x7f@]+>$/.test(source.messageId)) {
    throw new Error("Email handoff mailbox or Message-ID is invalid");
  }
  return {
    source: { ...source, pluginId: input.pluginId },
    originId: buildEmailHandoffOriginId({ ...source, pluginId: input.pluginId })!,
  };
}
