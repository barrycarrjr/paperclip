import type { MailboxInfo } from "../../api/emailTools";

/**
 * What to show as "From" at the point of sending.
 *
 * The rule, from docs/plans/2026-09-02-ux-control-center-scope.md: show the
 * sender or mailbox at the point of an outbound action, using the real
 * configured identity and never a guessed address. The compose dialog had a
 * To field and no From at all — the sending mailbox was whichever one
 * happened to be selected in the sidebar, which with four mailboxes across
 * companies is an easy thing to get wrong and a hard thing to notice until
 * the reply comes back to the wrong inbox.
 *
 * Prefers the real address. Falls back to the mailbox name, which is still a
 * configured identity the operator chose, and says plainly when nothing can
 * be determined rather than leaving the line off — an absent From reads as
 * "there is nothing to worry about", which is the opposite of the truth.
 */
export interface SendingIdentity {
  /** One line, ready to render. */
  label: string;
  /** True when the label is a real address rather than a mailbox name. */
  isAddress: boolean;
  /** True when no mailbox could be resolved at all. */
  unknown: boolean;
}

export function describeSendingIdentity(
  mailbox: Pick<MailboxInfo, "key" | "name" | "from"> | null | undefined,
): SendingIdentity {
  if (!mailbox) {
    return { label: "No mailbox selected", isAddress: false, unknown: true };
  }
  const address = mailbox.from?.trim();
  const name = mailbox.name?.trim() || mailbox.key;
  if (address) {
    // "Support <support@acme.example>" when the name adds something; the
    // bare address when the name IS the address or is missing.
    const label = name && name.toLowerCase() !== address.toLowerCase() ? `${name} <${address}>` : address;
    return { label, isAddress: true, unknown: false };
  }
  return { label: name, isAddress: false, unknown: false };
}

/** Look a mailbox up by the key the page tracks as selected. */
export function findSelectedMailbox(
  mailboxes: readonly MailboxInfo[],
  selectedKey: string | null | undefined,
): MailboxInfo | null {
  if (!selectedKey) return null;
  return mailboxes.find((mailbox) => mailbox.key === selectedKey) ?? null;
}
