import { useMutation } from "@tanstack/react-query";
import { useMemo } from "react";
import { makeEmailToolsApi, type MailHeader, type ParsedEmailMessage } from "../../api/emailTools";
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
  /** Short confirmation for the operator. `issueId` is set by a hand-off. */
  onToast?: (text: string, issueId?: string) => void;
  /**
   * A sender the operator has now acted on deliberately. The Email page
   * promotes these to keep-always so future mail is not auto-triaged; other
   * surfaces can leave it undone.
   */
  onSenderEngaged?: (msg: MailHeader) => Promise<void> | void;
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
    onError: (_e, msg) => hooks.onRevert?.(msg.uid),
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
    onError: (_e, msg) => {
      hooks.onRevert?.(msg.uid);
      hooks.onSettled?.();
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
    onError: (_e, msg) => {
      hooks.onRevert?.(msg.uid);
      hooks.onSettled?.();
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
    onError: (_e, { msg }) => {
      hooks.onRevert?.(msg.uid);
      hooks.onSettled?.();
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
      return api.sendNew(target.mailbox, to, subject, quoted);
    },
    onSuccess: () => {
      hooks.onSettled?.();
      hooks.onToast?.("Forwarded");
    },
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
      const issue = await issuesApi.create(target.companyId, {
        title: `Email from ${msg.from}: ${msg.subject}`.slice(0, 200),
        description,
        assigneeAgentId: agentId,
      });
      // Creating the issue only assigns it. Without a wake the agent will not
      // look at it until its next scheduled tick, or never if it is not on a
      // routine, which reads to the operator as the hand-off silently failing.
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
        // The issue exists and is assigned, so the hand-off stands.
        console.error("Failed to wake agent after handoff", err);
      }
      try {
        await api.markRead(target.mailbox, msg.uid, target.folder);
      } catch {
        // ignore
      }
      if (header) await hooks.onSenderEngaged?.(header);
      return { issueId: issue.id, uid: msg.uid };
    },
    onSuccess: ({ issueId, uid }) => {
      hooks.onOptimistic?.(uid, "read");
      hooks.onSettled?.();
      hooks.onToast?.("Handed off, issue created", issueId);
    },
  });

  return { markRead, markUnread, remove, moveToFolder, reply, forward, handOff };
}
