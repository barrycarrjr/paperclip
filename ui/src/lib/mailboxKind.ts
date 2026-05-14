/**
 * Discriminated union for "a mailbox the Email UI can show".
 *
 * The Email and PortfolioEmail pages used to assume every mailbox came from
 * the email-tools (IMAP) plugin. With help-scout 0.5.0 exposing UI bridge
 * actions, an HS account+mailbox pair is now also a valid mailbox. Keep the
 * shape narrow to what both pages actually need to drive the right pane.
 */

export interface ImapMailboxRef {
  kind: "imap";
  /** Plugin instance id for the email-tools plugin. */
  pluginId: string;
  /** Company whose context is used for the bridge call. For shared mailboxes
   *  with `allowedCompanies: ["*"]`, this is the currently-selected company. */
  primaryCompanyId: string;
  /** Mailbox identifier inside email-tools' config (e.g. "personal"). */
  key: string;
  /** Display name; the email-tools convention is "<label> - <addr@example.com>". */
  name: string;
  /** IMAP folder polled by triage routines (usually "INBOX"). */
  pollFolder: string;
  /** Raw allowedCompanies array from the plugin config, for badges and labels. */
  allowedCompanies: string[];
}

export interface HelpScoutMailboxRef {
  kind: "helpscout";
  /** Plugin instance id for the help-scout plugin. */
  pluginId: string;
  /** Company whose context is used for the bridge call. */
  primaryCompanyId: string;
  /** Account identifier inside help-scout's config (e.g. "support"). */
  accountKey: string;
  /** Numeric Help Scout mailbox id, stringified. */
  mailboxId: string;
  /** Display name from Help Scout (e.g. "Customer Support"). */
  name: string;
  /** Mailbox email address from Help Scout. */
  email: string;
  /** Account-level allowedCompanies, for badges. */
  allowedCompanies: string[];
}

export type MailboxRef = ImapMailboxRef | HelpScoutMailboxRef;

/** Stable key for React lists / URL params. Format: `imap:<companyId>:<key>` or
 *  `hs:<companyId>:<accountKey>:<mailboxId>`. */
export function mailboxRefId(m: MailboxRef): string {
  if (m.kind === "imap") {
    return `imap:${m.primaryCompanyId}:${m.key}`;
  }
  return `hs:${m.primaryCompanyId}:${m.accountKey}:${m.mailboxId}`;
}

/** Parse a mailbox URL param of the form above back into its parts, or null
 *  if the string doesn't match. The page uses this to restore selection from
 *  ?mailbox= on first load. */
export function parseMailboxRefId(s: string | null | undefined): {
  kind: "imap" | "helpscout";
  parts: string[];
} | null {
  if (!s) return null;
  if (s.startsWith("imap:")) {
    const parts = s.slice("imap:".length).split(":");
    if (parts.length < 2) return null;
    return { kind: "imap", parts };
  }
  if (s.startsWith("hs:")) {
    const parts = s.slice("hs:".length).split(":");
    if (parts.length < 3) return null;
    return { kind: "helpscout", parts };
  }
  // Legacy: bare IMAP mailbox key (no prefix). The old PortfolioEmail.tsx and
  // Email.tsx used this. Treat as IMAP.
  return { kind: "imap", parts: ["", s] };
}

/** Extract the "this is unread / needs my attention" count from an HS
 *  conversation list. Mirrors `unseen` count for IMAP. */
export function hsUnreadCount(
  conversations: Array<{ status: string | null }>,
): { active: number; pending: number; total: number } {
  let active = 0;
  let pending = 0;
  for (const c of conversations) {
    if (c.status === "active") active++;
    else if (c.status === "pending") pending++;
  }
  return { active, pending, total: active + pending };
}
