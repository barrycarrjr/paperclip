/**
 * Durable identity for an issue created by handing an email to an agent
 * (P5a — see docs/plans/2026-09-03-p5a-email-delegation-spec.md).
 *
 * Before this, an email handoff produced a plain issue whose only trace of
 * the source was the email body pasted into the description as text: nothing
 * could answer "which message is this issue about", "was this one already
 * handed off", or "where do I reply when it's resolved". These helpers give
 * that trace a stable, parseable form stored in the issue's existing
 * `originKind`/`originId` columns — no new table, and the existing
 * `issues_company_origin_idx` index already covers looking it up.
 *
 * Key shape (versioned, because it lives in the database and is parsed back
 * out later):
 *
 *   email:v1:msgid:<pluginId>:<mailbox>:<messageId>
 *   email:v1:uid:<pluginId>:<mailbox>:<folder>:<uid>
 *
 * Every component is URI-encoded, so a `:` inside a Message-Id (legal, and
 * real in the wild) cannot corrupt the key.
 *
 * `msgid` is preferred: a provider Message-Id survives the message being
 * moved between folders, which a UID does not — and a human filing an email
 * away after handing it off is an ordinary thing to do. `uid` is the
 * documented fallback for providers that don't expose a Message-Id, and its
 * reference is knowingly fragile across moves (see the spec's §2).
 */

const PREFIX = "email";
const VERSION = "v1";

/**
 * Not added to `ISSUE_ORIGIN_KINDS`, deliberately. That constant is already
 * not authoritative — `harness_liveness_escalation`, `stranded_issue_recovery`
 * and the portfolio-directive kind are all real, in use, and absent from it
 * (they live beside their own features, e.g. server's `recovery/origins.ts`).
 * This follows that established pattern rather than pretending the shared
 * list is complete.
 */
export const EMAIL_HANDOFF_ORIGIN_KIND = "email_handoff";

export type EmailHandoffSourceRef =
  | { kind: "msgid"; pluginId: string; mailbox: string; messageId: string }
  | { kind: "uid"; pluginId: string; mailbox: string; folder: string; uid: number };

export function isEmailHandoffOriginKind(originKind: string | null | undefined): boolean {
  return originKind === EMAIL_HANDOFF_ORIGIN_KIND;
}

/**
 * Build the stable source key for an email being handed off.
 *
 * Prefers the provider's Message-Id; falls back to mailbox/folder/uid only
 * when no Message-Id is available. Returns null when there isn't enough to
 * identify the source at all, so a caller can decide whether to proceed
 * without a durable reference rather than storing a meaningless one.
 */
export function buildEmailHandoffOriginId(input: {
  pluginId: string;
  mailbox: string;
  messageId?: string | null;
  folder?: string | null;
  uid?: number | null;
}): string | null {
  const pluginId = input.pluginId?.trim();
  const mailbox = input.mailbox?.trim();
  if (!pluginId || !mailbox) return null;

  const messageId = input.messageId?.trim();
  if (messageId) {
    return [PREFIX, VERSION, "msgid", enc(pluginId), enc(mailbox), enc(messageId)].join(":");
  }

  const folder = input.folder?.trim();
  const uid = input.uid;
  if (folder && typeof uid === "number" && Number.isInteger(uid)) {
    return [PREFIX, VERSION, "uid", enc(pluginId), enc(mailbox), enc(folder), String(uid)].join(":");
  }

  return null;
}

/** Inverse of `buildEmailHandoffOriginId`. Null for anything unrecognized. */
export function parseEmailHandoffOriginId(
  originId: string | null | undefined,
): EmailHandoffSourceRef | null {
  if (!originId) return null;
  const parts = originId.split(":");
  if (parts[0] !== PREFIX || parts[1] !== VERSION) return null;

  if (parts[2] === "msgid" && parts.length === 6) {
    const [, , , pluginId, mailbox, messageId] = parts;
    if (!pluginId || !mailbox || !messageId) return null;
    return { kind: "msgid", pluginId: dec(pluginId), mailbox: dec(mailbox), messageId: dec(messageId) };
  }

  if (parts[2] === "uid" && parts.length === 7) {
    const [, , , pluginId, mailbox, folder, rawUid] = parts;
    if (!pluginId || !mailbox || !folder || !rawUid) return null;
    const uid = Number(rawUid);
    if (!Number.isInteger(uid)) return null;
    return { kind: "uid", pluginId: dec(pluginId), mailbox: dec(mailbox), folder: dec(folder), uid };
  }

  return null;
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

function dec(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A hand-edited or truncated key shouldn't throw on read — the caller
    // treats a nonsense component the same as an unparseable key.
    return value;
  }
}
