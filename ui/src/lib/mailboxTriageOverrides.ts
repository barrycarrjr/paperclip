/**
 * Cross-view triage overrides.
 *
 * Portfolio Email and the per-company Email page render the same mailboxes out
 * of the same react-query cache. Each used to hide a row it had just triaged
 * with its own component-local `useState`, so the note never reached the other
 * view. Combined with the global 30s `staleTime` in main.tsx, a message marked
 * read (or a Help Scout conversation closed) on one screen kept showing on the
 * other for up to half a minute.
 *
 * This module keeps that "I just did something to this row" note in one
 * module-level store, scoped per mailbox, so both views derive the same list.
 * Recording the resulting *state* rather than a blunt "hide this id" is what
 * lets one note mean the right thing under every filter: a conversation set to
 * pending drops out of an "active" list but stays put under "open", and a
 * message marked read leaves the unread list while staying visible (dot off)
 * when the operator is showing everything.
 *
 * The note also survives a refetch, which matters because Help Scout keeps
 * reporting a conversation's old status for a few seconds after a status
 * change. Without that the row pops straight back in.
 *
 * Notes expire after OVERRIDE_TTL_MS so a stale one can never hide a row for
 * good (the operator may well reopen a conversation in Help Scout's own web
 * UI). After that the server is authoritative again.
 */

/** How long a note keeps overriding the server's view of a row. Two poll
 *  cycles: long enough to outlast Help Scout's eventual consistency, short
 *  enough that a change made elsewhere shows up on its own. */
export const OVERRIDE_TTL_MS = 60_000;

/** What we just did to an IMAP message.
 *  - `read` / `unread`: still in the folder, seen flag flipped.
 *  - `gone`: left the folder entirely (deleted, moved, auto-triaged). */
export type ImapOverrideKind = "read" | "unread" | "gone";

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export type ImapOverrides = ReadonlyMap<number, Entry<ImapOverrideKind>>;
/** Value is the Help Scout status we just set ("closed", "pending", ...). */
export type HelpScoutOverrides = ReadonlyMap<string, Entry<string>>;

class OverrideStore<K, V> {
  private readonly scopes = new Map<string, Map<K, Entry<V>>>();
  private readonly listeners = new Set<() => void>();
  private readonly empty: ReadonlyMap<K, Entry<V>> = new Map<K, Entry<V>>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Returns the same reference until something mutates the scope, which is
   *  what useSyncExternalStore requires of getSnapshot. Expired entries are
   *  pruned on write and skipped on read, never filtered here, because
   *  rebuilding the map per render would loop forever. */
  snapshot = (scope: string | null): ReadonlyMap<K, Entry<V>> => {
    if (!scope) return this.empty;
    return this.scopes.get(scope) ?? this.empty;
  };

  set(scope: string, key: K, value: V, now: number = Date.now()): void {
    const next = this.withoutExpired(scope, now);
    next.set(key, { value, expiresAt: now + OVERRIDE_TTL_MS });
    this.scopes.set(scope, next);
    this.emit();
  }

  clear(scope: string, key: K): void {
    const current = this.scopes.get(scope);
    if (!current?.has(key)) return;
    const next = new Map(current);
    next.delete(key);
    if (next.size === 0) this.scopes.delete(scope);
    else this.scopes.set(scope, next);
    this.emit();
  }

  /** Test hook. Nothing in the app clears every scope at once. */
  reset(): void {
    if (this.scopes.size === 0) return;
    this.scopes.clear();
    this.emit();
  }

  private withoutExpired(scope: string, now: number): Map<K, Entry<V>> {
    const next = new Map<K, Entry<V>>();
    const current = this.scopes.get(scope);
    if (!current) return next;
    for (const [k, entry] of current) {
      if (entry.expiresAt > now) next.set(k, entry);
    }
    return next;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const imapOverrideStore = new OverrideStore<number, ImapOverrideKind>();
export const helpScoutOverrideStore = new OverrideStore<string, string>();

/** Scope for one IMAP folder. The folder belongs in the key because IMAP uids
 *  are per-folder, so a uid marked read in Archive says nothing about INBOX. */
export function imapMailboxScope(
  pluginId: string,
  companyId: string,
  mailboxKey: string,
  folder: string,
): string {
  return `imap:${pluginId}:${companyId}:${mailboxKey}:${folder}`;
}

/** Scope for one Help Scout mailbox. Status is deliberately absent: the note
 *  records what the conversation became, and each list decides for itself
 *  whether that still matches its filter. */
export function helpScoutMailboxScope(
  pluginId: string,
  companyId: string,
  accountKey: string,
  mailboxId: string,
): string {
  return `hs:${pluginId}:${companyId}:${accountKey}:${mailboxId}`;
}

interface MessageLike {
  uid: number;
  unseen: boolean;
}

/**
 * Fold pending notes into a fetched message list.
 *
 * `unseenOnly` mirrors the list's own filter (the unread-only toggle), which is
 * what decides whether a read message disappears or simply loses its dot.
 */
export function applyImapOverrides<T extends MessageLike>(
  messages: readonly T[],
  overrides: ImapOverrides,
  opts: { unseenOnly: boolean; now?: number },
): T[] {
  if (overrides.size === 0) return messages as T[];
  const now = opts.now ?? Date.now();
  const out: T[] = [];
  for (const msg of messages) {
    const entry = overrides.get(msg.uid);
    if (!entry || entry.expiresAt <= now) {
      out.push(msg);
      continue;
    }
    switch (entry.value) {
      case "gone":
        break;
      case "read":
        if (!opts.unseenOnly) out.push(msg.unseen ? { ...msg, unseen: false } : msg);
        break;
      case "unread":
        out.push(msg.unseen ? msg : { ...msg, unseen: true });
        break;
    }
  }
  return out;
}

/** Help Scout's "open" filter is the union of active and pending; every other
 *  filter is an exact status match. */
export function helpScoutStatusMatchesFilter(status: string, filter: string): boolean {
  if (filter === "open") return status === "active" || status === "pending";
  return status === filter;
}

interface ConversationLike {
  id: string;
  status: string | null;
}

/**
 * Fold pending notes into a fetched conversation list.
 *
 * A conversation whose new status no longer matches `filter` drops out; one
 * that still matches stays, with its status rewritten so per-status counts and
 * dot colours agree with what the operator just clicked.
 */
export function applyHelpScoutOverrides<T extends ConversationLike>(
  conversations: readonly T[],
  overrides: HelpScoutOverrides,
  opts: { filter: string; now?: number },
): T[] {
  if (overrides.size === 0) return conversations as T[];
  const now = opts.now ?? Date.now();
  const out: T[] = [];
  for (const conv of conversations) {
    const entry = overrides.get(conv.id);
    if (!entry || entry.expiresAt <= now) {
      out.push(conv);
      continue;
    }
    if (!helpScoutStatusMatchesFilter(entry.value, opts.filter)) continue;
    out.push(conv.status === entry.value ? conv : { ...conv, status: entry.value });
  }
  return out;
}

/**
 * Matches every cached variant of the IMAP message list for one mailbox:
 * `["email", pluginId, companyId, mailboxKey, <folder>, "all" | "unseen"]`.
 *
 * Used as a react-query invalidation predicate so acting on one screen also
 * refreshes the other screen's variant (different folder, different unread
 * toggle). Deliberately narrower than a plain key prefix so it leaves the
 * sibling "rules" and single-message queries alone; the single-message key is
 * the same length but carries a uid where this one carries "all"/"unseen".
 */
export function isImapMessageListKey(
  key: readonly unknown[],
  scope: { pluginId: string; companyId: string; mailboxKey: string },
): boolean {
  return (
    key.length === 6 &&
    key[0] === "email" &&
    key[1] === scope.pluginId &&
    key[2] === scope.companyId &&
    key[3] === scope.mailboxKey &&
    typeof key[4] === "string" &&
    (key[5] === "all" || key[5] === "unseen")
  );
}

/**
 * Matches every cached variant of the Help Scout conversation list for one
 * mailbox: `["helpscout", pluginId, companyId, accountKey, mailboxId, <status>]`.
 *
 * The single-conversation key is the same length but holds the literal "conv"
 * where this one holds a stringified numeric mailbox id, so the two can't
 * collide.
 */
export function isHelpScoutListKey(
  key: readonly unknown[],
  scope: { pluginId: string; companyId: string; accountKey: string; mailboxId: string },
): boolean {
  return (
    key.length === 6 &&
    key[0] === "helpscout" &&
    key[1] === scope.pluginId &&
    key[2] === scope.companyId &&
    key[3] === scope.accountKey &&
    key[4] === scope.mailboxId &&
    typeof key[5] === "string"
  );
}
