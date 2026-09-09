/**
 * Which of the three mail views is showing.
 *
 * The app had one eye-shaped button that flipped between "everything" and
 * "unread only". The mockup asks for three tabs: All mail, Unread, and With
 * agents. Those are the same choice, so the button becomes the first two
 * tabs and the third is the new one. Nothing is lost: the same two views are
 * still one click apart, they are now named instead of being an icon whose
 * meaning depended on which way round it was.
 *
 * The remembered preference is stored under a new name because it can now
 * hold three values, and the old two-value key is still read once so anyone
 * who had chosen "unread only" keeps it.
 */

export const EMAIL_LIST_VIEWS = ["all", "unread", "agents"] as const;
export type EmailListView = (typeof EMAIL_LIST_VIEWS)[number];

export const EMAIL_LIST_VIEW_STORAGE_KEY = "email-listView";
/** The two-value key this replaces. Still written, so going back works. */
export const EMAIL_SHOW_ALL_STORAGE_KEY = "email-showAll";

export const EMAIL_LIST_VIEW_LABEL: Record<EmailListView, string> = {
  all: "All mail",
  unread: "Unread",
  agents: "With agents",
};

export function isEmailListView(value: unknown): value is EmailListView {
  return typeof value === "string" && (EMAIL_LIST_VIEWS as readonly string[]).includes(value);
}

/**
 * Which view to open on.
 *
 * `?all=` in the web address wins, because a link that says which view it
 * wants is someone being explicit and should beat a remembered preference.
 * "With agents" is never restored from a link, only chosen, since `?all=`
 * has only ever meant read or unread.
 */
export function initialEmailListView(input: {
  allParam: string | null;
  stored: string | null;
  legacyShowAll: string | null;
}): EmailListView {
  if (input.allParam === "1") return "all";
  if (input.allParam === "0") return "unread";
  if (isEmailListView(input.stored)) return input.stored;
  return input.legacyShowAll === "true" ? "all" : "unread";
}

/** The unread-only filter the message query has always used. */
export function listViewShowsAllMail(view: EmailListView): boolean {
  return view !== "unread";
}

/** What to say when a view has nothing in it. */
export function emptyListMessage(view: EmailListView): string {
  if (view === "unread") return "No unread messages. Choose All mail to see the rest.";
  return "No messages in this folder.";
}
