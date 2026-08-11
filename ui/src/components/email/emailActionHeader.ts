import type { MailHeader, ParsedEmailMessage, SearchHit } from "../../api/emailTools";

export interface ActionHeaderSources {
  /** The uid the viewer is showing, or null when nothing is open. */
  uid: number | null;
  /** Rows of the folder list behind the viewer, filters already applied. */
  listRows?: readonly MailHeader[];
  /** Rows of an active search, which crosses mailboxes and folders. */
  searchHits?: readonly SearchHit[];
  /** Where the viewer is looking, so a search hit from elsewhere is not used. */
  location?: { mailbox: string | null; folder: string };
  /** The fetched message, used only when no list holds the row. */
  openMessage?: ParsedEmailMessage | null;
  /** Seen state to assume for a row built from the fetched message alone. */
  assumeUnseen?: boolean;
}

/**
 * The list row the message actions act on.
 *
 * Every action on an open email (mark read, keep always, auto-triage, move,
 * delete) wants the row, not the body: it needs the uid and the sender, and the
 * surface it came from needs to know which row to hide. The viewer, though,
 * renders straight from a fetch by uid, so it can perfectly well be showing a
 * message that no list on screen contains — a search hit from another folder, a
 * read message while the list is filtered to unread, or anything past the list's
 * row limit, which is what a ?uid= link from Portfolio Email routinely lands on.
 * Each of those used to leave the toolbar with nothing to act on, so its buttons
 * rendered as usual and then quietly did nothing when clicked.
 *
 * So the row is taken from the list when the list has it, from the search
 * results when a search is what opened it, and otherwise rebuilt from the
 * fetched message. The rebuilt row carries everything the actions read except
 * the seen flag: IMAP reports that when listing a folder, not when fetching one
 * message, so the caller says which state to assume — normally whichever one
 * its list is filtered to.
 */
export function resolveActionHeader(sources: ActionHeaderSources): MailHeader | null {
  const { uid, listRows, searchHits, location, openMessage, assumeUnseen } = sources;
  if (uid === null) return null;

  const listed = listRows?.find((row) => row.uid === uid);
  if (listed) return listed;

  const hit = searchHits?.find(
    (h) =>
      h.uid === uid
      && (!location || (h.mailbox === location.mailbox && h.folder === location.folder)),
  );
  if (hit) return hit;

  if (!openMessage || openMessage.uid !== uid) return null;
  return {
    uid: openMessage.uid,
    messageId: openMessage.messageId,
    from: openMessage.from,
    subject: openMessage.subject,
    date: openMessage.date,
    snippet: "",
    unseen: assumeUnseen ?? false,
  };
}
