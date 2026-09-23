/** Where the message being forwarded lives, captured when the forward opens. */
export interface ForwardSource {
  mailbox: string;
  folder: string;
  messageId: string | null;
}

/**
 * What a forward from the Email page's compose dialog tells the plugin about
 * the message it forwards, so the mailbox can mark that message forwarded (the
 * icon Outlook shows). Null when there is nothing safe to name.
 *
 * A uid only names a message inside the mailbox and folder it came from, so
 * nothing is named once the page has moved to another mailbox; the plugin
 * would otherwise mark whichever message holds that number there. The
 * Message-ID rides along so the plugin can check it has the right one.
 */
export function forwardOfFor(args: {
  mode: "new" | "forward";
  sourceUid: number | null;
  source: ForwardSource | null;
  sendingMailbox: string | null;
}): { uid: number; folder: string; messageId?: string } | null {
  const { mode, sourceUid, source, sendingMailbox } = args;
  if (mode !== "forward" || sourceUid === null || !Number.isInteger(sourceUid)) return null;
  if (!source || !sendingMailbox || source.mailbox !== sendingMailbox) return null;
  return {
    uid: sourceUid,
    folder: source.folder,
    ...(source.messageId ? { messageId: source.messageId } : {}),
  };
}
