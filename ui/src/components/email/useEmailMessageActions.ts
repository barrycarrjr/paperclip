import { useMutation } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  makeEmailToolsApi,
  type EmailSendAttachment,
  type MailHeader,
  type ParsedEmailMessage,
} from "../../api/emailTools";
import { buildEmailHandoffOriginId, EMAIL_HANDOFF_ORIGIN_KIND } from "@paperclipai/shared";
import { visibleEmailAttachments } from "../../lib/attachments";
import { actionFailureText } from "./actionFailure";
import { issuesApi } from "../../api/issues";
import { agentsApi } from "../../api/agents";

export interface EmailMessageTarget {
  pluginId: string;
  companyId: string;
  /** email-tools mailbox key, e.g. "personal". */
  mailbox: string;
  /** IMAP folder the message lives in. */
  folder: string;
}

export interface EmailMessageActionHooks {
  /**
   * Called before the request goes out so the caller can hide the row
   * optimistically. `kind` mirrors the page's own override vocabulary.
   */
  onOptimistic?: (uid: number, kind: "read" | "unread" | "gone") => void;
  /** Called when the request failed and the optimistic hide must be undone. */
  onRevert?: (uid: number) => void;
  /** Called after a successful mutation so the caller can refetch its lists. */
  onSettled?: () => void;
  /**
   * Short confirmation for the operator. `issueId` is set by a hand-off —
   * despite the name, it's the issue's human-readable identifier when one
   * exists (e.g. "IND-42"), falling back to the raw id otherwise, ready to
   * drop into an `/issues/<issueId>` link. `failed` is true when this is
   * reporting a failure through the same channel a success would have used
   * (see `reportFailure` below) — callers that render this as a plain
   * neutral toast regardless of `failed` reproduce the exact silent-failure
   * problem this hook exists to avoid.
   */
  onToast?: (text: string, issueId?: string, failed?: boolean) => void;
  /**
   * A sender the operator has now acted on deliberately. The Email page
   * promotes these to keep-always so future mail is not auto-triaged; other
   * surfaces can leave it undone.
   */
  onSenderEngaged?: (msg: MailHeader) => Promise<void> | void;
}

/**
 * Say out loud that an action failed, through the same channel its success
 * would have used.
 *
 * Only the forward used to report a failure, and only the bare message. Every
 * other action failed in complete silence, which reads to the operator as the
 * click not registering: on a failed forward the composer stays open with the
 * recipient and the note still in it, exactly as it looked before the click.
 */
function reportFailure(hooks: EmailMessageActionHooks, action: string, err: unknown): void {
  hooks.onToast?.(actionFailureText(action, err), undefined, true);
}

/**
 * The six things an operator can do to a single email.
 *
 * These used to live inline in the Email page, which meant every other surface
 * that showed an email could only offer the subset it had reimplemented: the
 * portfolio list had mark read/unread and delete, but forwarding, moving and
 * handing off to an agent existed only after navigating into the company. The
 * behaviour is fiddlier than it looks (a reply also marks read, a hand-off also
 * wakes the agent and marks read), so a second copy would drift. Everything
 * that shows an email now drives it from here and the page keeps only its own
 * list bookkeeping, passed in as callbacks.
 */
export function useEmailMessageActions(
  target: EmailMessageTarget | null,
  hooks: EmailMessageActionHooks = {},
) {
  const pluginId = target?.pluginId ?? null;
  const companyId = target?.companyId ?? null;
  const api = useMemo(
    () => (pluginId && companyId ? makeEmailToolsApi(pluginId, companyId) : null),
    [pluginId, companyId],
  );

  function mustHaveMailbox(): { api: NonNullable<typeof api>; target: EmailMessageTarget } {
    if (!api || !target) throw new Error("No mailbox selected.");
    return { api, target };
  }

  const markRead = useMutation({
    mutationFn: async (msg: MailHeader) => {
      const { api, target } = mustHaveMailbox();
      hooks.onOptimistic?.(msg.uid, "read");
      await api.markRead(target.mailbox, msg.uid, target.folder);
      await hooks.onSenderEngaged?.(msg);
    },
    onSuccess: (_r, msg) => {
      hooks.onSettled?.();
      hooks.onToast?.(`Marked read: ${msg.subject || "(no subject)"}`);
    },
    onError: (err, msg) => {
      hooks.onRevert?.(msg.uid);
      reportFailure(hooks, "Mark read", err);
    },
  });

  const markUnread = useMutation({
    mutationFn: async (msg: MailHeader) => {
      const { api, target } = mustHaveMailbox();
      hooks.onOptimistic?.(msg.uid, "unread");
      await api.markUnread(target.mailbox, msg.uid, target.folder);
    },
    onSuccess: (_r, msg) => {
      hooks.onSettled?.();
      hooks.onToast?.(`Marked unread: ${msg.subject || "(no subject)"}`);
    },
    onError: (err, msg) => {
      hooks.onRevert?.(msg.uid);
      hooks.onSettled?.();
      reportFailure(hooks, "Mark unread", err);
    },
  });

  const remove = useMutation({
    mutationFn: async (msg: MailHeader) => {
      const { api, target } = mustHaveMailbox();
      hooks.onOptimistic?.(msg.uid, "gone");
      return api.deleteMessage(target.mailbox, msg.uid, target.folder);
    },
    onSuccess: () => {
      hooks.onSettled?.();
      hooks.onToast?.("Deleted");
    },
    onError: (err, msg) => {
      hooks.onRevert?.(msg.uid);
      hooks.onSettled?.();
      reportFailure(hooks, "Delete", err);
    },
  });

  const moveToFolder = useMutation({
    mutationFn: async ({ msg, targetFolder }: { msg: MailHeader; targetFolder: string }) => {
      const { api, target } = mustHaveMailbox();
      hooks.onOptimistic?.(msg.uid, "gone");
      await api.moveMessage(target.mailbox, msg.uid, target.folder, targetFolder);
    },
    onSuccess: (_r, { targetFolder }) => {
      hooks.onSettled?.();
      hooks.onToast?.(`Moved to ${targetFolder}`);
    },
    onError: (err, { msg }) => {
      hooks.onRevert?.(msg.uid);
      hooks.onSettled?.();
      reportFailure(hooks, "Move", err);
    },
  });

  const reply = useMutation({
    mutationFn: async ({
      msg,
      body,
      replyAll,
    }: {
      msg: MailHeader;
      body: string;
      replyAll: boolean;
    }) => {
      const { api, target } = mustHaveMailbox();
      await api.sendReply(target.mailbox, msg.uid, target.folder, body, { replyAll });
      // Replying is disposal: mark read so it leaves the unread view here and
      // in the operator's own mail client. A failure here must not fail the
      // send, which has already happened and cannot be taken back.
      try {
        await api.markRead(target.mailbox, msg.uid, target.folder);
      } catch {
        // ignore
      }
      await hooks.onSenderEngaged?.(msg);
    },
    onSuccess: (_r, { msg }) => {
      hooks.onOptimistic?.(msg.uid, "read");
      hooks.onSettled?.();
      hooks.onToast?.("Reply sent");
    },
    onError: (err) => reportFailure(hooks, "Reply", err),
  });

  const forward = useMutation({
    mutationFn: async ({
      msg,
      to,
      note,
    }: {
      msg: ParsedEmailMessage;
      to: string;
      note: string;
    }) => {
      const { api, target } = mustHaveMailbox();
      const quoted = [
        note.trim(),
        note.trim() ? "" : null,
        "---------- Forwarded message ----------",
        `From: ${msg.from}`,
        `Date: ${msg.date}`,
        `Subject: ${msg.subject}`,
        msg.to.length ? `To: ${msg.to.join(", ")}` : null,
        "",
        msg.text || msg.markdown || "(no body)",
      ]
        .filter((line) => line !== null)
        .join("\n");
      const subject = /^fwd:/i.test(msg.subject) ? msg.subject : `Fwd: ${msg.subject}`;
      // A forward carries the original files along, so fetch each one from
      // the mailbox first. A failed fetch fails the whole forward: sending
      // the message without a file it claims to carry is worse than an error
      // the operator can retry.
      const attachments: EmailSendAttachment[] = [];
      for (const meta of visibleEmailAttachments(msg.attachments)) {
        let fetched;
        try {
          fetched = await api.getAttachment(target.mailbox, target.folder, msg.uid, meta.partId);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          throw new Error(`Could not fetch attachment "${meta.name}": ${reason}`);
        }
        attachments.push({
          name: fetched.name || meta.name,
          mime: fetched.mime || meta.mime,
          contentBase64: fetched.contentBase64,
        });
      }
      return api.sendNew(
        target.mailbox,
        to,
        subject,
        quoted,
        attachments.length > 0 ? { attachments } : undefined,
      );
    },
    onSuccess: (_r, { msg }) => {
      hooks.onSettled?.();
      const count = visibleEmailAttachments(msg.attachments).length;
      hooks.onToast?.(count > 0 ? `Forwarded with ${count} attachment${count === 1 ? "" : "s"}` : "Forwarded");
    },
    onError: (err) => reportFailure(hooks, "Forward", err),
  });

  const handOff = useMutation({
    mutationFn: async ({
      msg,
      agentId,
      note,
      header,
    }: {
      msg: ParsedEmailMessage;
      agentId: string;
      note: string;
      /** List row for the same message, when the caller has one. */
      header?: MailHeader;
    }) => {
      const { api, target } = mustHaveMailbox();
      const trimmed = note.trim();
      const noteBlock = trimmed ? `## Operator note\n\n${trimmed}\n\n---\n\n` : "";
      const description =
        `${noteBlock}${msg.markdown || msg.text || "(no body)"}\n\n---\n` +
        `**From:** ${msg.from}\n` +
        `**Subject:** ${msg.subject}\n` +
        `**Date:** ${msg.date}`;
      // Durable link back to the source message (P5a). Without this the only
      // trace of which email an issue came from is the body text pasted into
      // the description above.
      const originId = buildEmailHandoffOriginId({
        pluginId: target.pluginId,
        mailbox: target.mailbox,
        messageId: msg.messageId,
        folder: target.folder,
        uid: msg.uid,
      });
      const issue = await issuesApi.create(target.companyId, {
        title: `Email from ${msg.from}: ${msg.subject}`.slice(0, 200),
        description,
        assigneeAgentId: agentId,
        ...(originId ? { origin: { kind: EMAIL_HANDOFF_ORIGIN_KIND, id: originId } } : {}),
      });
      // Creating the issue only assigns it. Without a wake the agent will not
      // look at it until its next scheduled tick, or never if it is not on a
      // routine, which reads to the operator as the hand-off silently failing.
      // The issue itself still exists and is assigned either way, so this is
      // reported as a partial success (via wakeFailed below), not an error.
      let wakeFailed = false;
      try {
        await agentsApi.wakeup(
          agentId,
          {
            source: "assignment",
            triggerDetail: "manual",
            reason: "operator_email_handoff",
            payload: { issueId: issue.id },
            idempotencyKey: `email-handoff:${issue.id}`,
          },
          target.companyId,
        );
      } catch (err) {
        wakeFailed = true;
        console.error("Failed to wake agent after handoff", err);
      }
      try {
        await api.markRead(target.mailbox, msg.uid, target.folder);
      } catch {
        // ignore
      }
      if (header) await hooks.onSenderEngaged?.(header);
      // Prefer the human-readable identifier (e.g. "IND-42") over the raw
      // UUID for the link the operator sees — it's what every other issue
      // link in the app uses (see PortfolioBrief.tsx).
      return { issueId: issue.identifier ?? issue.id, uid: msg.uid, wakeFailed };
    },
    onSuccess: ({ issueId, uid, wakeFailed }) => {
      hooks.onOptimistic?.(uid, "read");
      hooks.onSettled?.();
      hooks.onToast?.(
        wakeFailed
          ? "Handed off, issue created — the agent couldn't be woken and may not start until its next scheduled check"
          : "Handed off, issue created",
        issueId,
      );
    },
    onError: (err) => reportFailure(hooks, "Hand-off", err),
  });

  return { markRead, markUnread, remove, moveToFolder, reply, forward, handOff };
}
