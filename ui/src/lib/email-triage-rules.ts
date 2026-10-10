/**
 * What is actually waiting on you in a mailbox: the unread mail that no rule
 * covers, grouped by sender.
 *
 * Derived on read rather than stored. The set of senders needing a decision is
 * exactly "unread mail" minus "senders already covered by a rule", and both of
 * those are already available, so computing it here means the Email page, the
 * Morning Brief and the Portfolio Brief cannot disagree about the same mailbox,
 * and acting on a sender anywhere is reflected everywhere with nothing to keep
 * in sync.
 */

export function extractEmailAddress(from: string): string | null {
  const angle = /<([^>]+)>/.exec(from);
  if (angle) return angle[1]!.trim().toLowerCase();
  if (/@/.test(from)) return from.trim().toLowerCase();
  return null;
}

export interface ReviewMailHeader {
  uid: number;
  from: string;
  date: string;
}

export interface ReviewSenderRule {
  senderPattern: string;
}

export interface ReviewSenderGroup {
  sender: string;
  count: number;
  /** Newest first, so the head is the one to preview. */
  messages: ReviewMailHeader[];
}

/** A rule on the exact address, or on its `@domain`, covers the sender. */
export function isSenderRuled(address: string, rulePatterns: ReadonlySet<string>): boolean {
  const addr = address.toLowerCase();
  if (rulePatterns.has(addr)) return true;
  const at = addr.indexOf("@");
  if (at < 0) return false;
  return rulePatterns.has(`@${addr.slice(at + 1)}`);
}

export function buildReviewSenderGroups(
  messages: readonly ReviewMailHeader[],
  rules: readonly ReviewSenderRule[],
): ReviewSenderGroup[] {
  const patterns = new Set(rules.map((rule) => rule.senderPattern.toLowerCase()));

  const groups = new Map<string, ReviewMailHeader[]>();
  for (const message of messages) {
    const address = extractEmailAddress(message.from);
    if (address && isSenderRuled(address, patterns)) continue;
    // A sender with no readable address still needs somewhere to go, or it
    // silently disappears from the only list that would have shown it.
    const key = address ?? message.from.trim().toLowerCase();
    const list = groups.get(key);
    if (list) list.push(message);
    else groups.set(key, [message]);
  }

  const out: ReviewSenderGroup[] = [];
  for (const [sender, list] of groups) {
    const sorted = [...list].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    out.push({ sender, count: sorted.length, messages: sorted });
  }
  // Noisiest first: that is the one worth a rule.
  return out.sort((a, b) => b.count - a.count || a.sender.localeCompare(b.sender));
}

/**
 * The other half of Dismiss. The rows here are worked out live, but the
 * triage routine also keeps its own review queue in email-tools (the senders
 * it surfaced, with its notes), and would keep reporting a dismissed sender
 * as waiting. A rule clears that entry by itself; Dismiss writes no rule, so
 * it has to say so.
 *
 * An email-tools older than 0.20.0 has no queue, and answers that it has no
 * such action. That one answer is let through, so Dismiss keeps working until
 * the plugin is updated (the mail is marked read either way). Any other
 * failure is real and is passed on, so the Brief can show it.
 */
export async function clearStoredReviewEntry(
  api: { dismissReviewEntry(mailbox: string, sender: string): Promise<unknown> } | null,
  row: { mailbox: string; sender: string },
): Promise<void> {
  if (!api) return;
  try {
    await api.dismissReviewEntry(row.mailbox, row.sender);
  } catch (err) {
    if (isMissingPluginAction(err)) return;
    throw err;
  }
}

/** The plugin worker's answer when the installed version has no such action. */
export function isMissingPluginAction(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /No action handler registered for key/i.test(message);
}
