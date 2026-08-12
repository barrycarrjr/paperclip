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
