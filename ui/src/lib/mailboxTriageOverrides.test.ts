import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OVERRIDE_TTL_MS,
  applyHelpScoutOverrides,
  applyImapOverrides,
  helpScoutMailboxScope,
  helpScoutOverrideStore,
  helpScoutStatusMatchesFilter,
  imapMailboxScope,
  imapOverrideStore,
  isHelpScoutListKey,
  isImapMessageListKey,
  type HelpScoutOverrides,
  type ImapOverrideKind,
  type ImapOverrides,
} from "./mailboxTriageOverrides";

const NOW = 1_700_000_000_000;

afterEach(() => {
  imapOverrideStore.reset();
  helpScoutOverrideStore.reset();
  vi.useRealTimers();
});

function imapOverrides(
  entries: Array<[number, ImapOverrideKind, number?]>,
): ImapOverrides {
  return new Map(
    entries.map(([uid, value, expiresAt]) => [
      uid,
      { value, expiresAt: expiresAt ?? NOW + OVERRIDE_TTL_MS },
    ]),
  );
}

function hsOverrides(entries: Array<[string, string, number?]>): HelpScoutOverrides {
  return new Map(
    entries.map(([id, value, expiresAt]) => [
      id,
      { value, expiresAt: expiresAt ?? NOW + OVERRIDE_TTL_MS },
    ]),
  );
}

const messages = [
  { uid: 1, unseen: true, subject: "one" },
  { uid: 2, unseen: true, subject: "two" },
  { uid: 3, unseen: false, subject: "three" },
];

describe("applyImapOverrides", () => {
  it("returns the same array when there is nothing pending", () => {
    const out = applyImapOverrides(messages, new Map(), { unseenOnly: true, now: NOW });
    expect(out).toBe(messages);
  });

  it("hides a message marked read from an unread-only list", () => {
    const out = applyImapOverrides(messages, imapOverrides([[2, "read"]]), {
      unseenOnly: true,
      now: NOW,
    });
    expect(out.map((m) => m.uid)).toEqual([1, 3]);
  });

  it("keeps a message marked read in a show-everything list, with the flag flipped", () => {
    const out = applyImapOverrides(messages, imapOverrides([[2, "read"]]), {
      unseenOnly: false,
      now: NOW,
    });
    expect(out.map((m) => m.uid)).toEqual([1, 2, 3]);
    expect(out.find((m) => m.uid === 2)!.unseen).toBe(false);
  });

  it("does not mutate the cached message it rewrites", () => {
    applyImapOverrides(messages, imapOverrides([[2, "read"]]), {
      unseenOnly: false,
      now: NOW,
    });
    expect(messages[1]!.unseen).toBe(true);
  });

  it("drops a message that left the folder from either list", () => {
    for (const unseenOnly of [true, false]) {
      const out = applyImapOverrides(messages, imapOverrides([[1, "gone"]]), {
        unseenOnly,
        now: NOW,
      });
      expect(out.map((m) => m.uid)).toEqual([2, 3]);
    }
  });

  it("shows a message marked unread as unread even while the server still says read", () => {
    const out = applyImapOverrides(messages, imapOverrides([[3, "unread"]]), {
      unseenOnly: true,
      now: NOW,
    });
    expect(out.find((m) => m.uid === 3)!.unseen).toBe(true);
  });

  it("ignores an expired note so the server becomes authoritative again", () => {
    const out = applyImapOverrides(messages, imapOverrides([[2, "read", NOW - 1]]), {
      unseenOnly: true,
      now: NOW,
    });
    expect(out.map((m) => m.uid)).toEqual([1, 2, 3]);
  });
});

describe("helpScoutStatusMatchesFilter", () => {
  it("treats open as active plus pending", () => {
    expect(helpScoutStatusMatchesFilter("active", "open")).toBe(true);
    expect(helpScoutStatusMatchesFilter("pending", "open")).toBe(true);
    expect(helpScoutStatusMatchesFilter("closed", "open")).toBe(false);
    expect(helpScoutStatusMatchesFilter("spam", "open")).toBe(false);
  });

  it("matches every other filter exactly", () => {
    expect(helpScoutStatusMatchesFilter("pending", "active")).toBe(false);
    expect(helpScoutStatusMatchesFilter("active", "active")).toBe(true);
    expect(helpScoutStatusMatchesFilter("closed", "closed")).toBe(true);
    expect(helpScoutStatusMatchesFilter("spam", "closed")).toBe(false);
  });
});

const conversations = [
  { id: "a", status: "active" },
  { id: "b", status: "active" },
  { id: "c", status: "pending" },
];

describe("applyHelpScoutOverrides", () => {
  it("returns the same array when there is nothing pending", () => {
    const out = applyHelpScoutOverrides(conversations, new Map(), {
      filter: "active",
      now: NOW,
    });
    expect(out).toBe(conversations);
  });

  it("hides a closed conversation from the active and open lists", () => {
    for (const filter of ["active", "open"]) {
      const out = applyHelpScoutOverrides(conversations, hsOverrides([["a", "closed"]]), {
        filter,
        now: NOW,
      });
      expect(out.map((c) => c.id)).toEqual(["b", "c"]);
    }
  });

  it("keeps a closed conversation on the closed list", () => {
    // The closed tab's own fetch is what puts "a" in this list; the note must
    // not then hide it. Rows with no note pass through untouched either way,
    // because the server has already filtered them.
    const closedList = [{ id: "a", status: "closed" }];
    const out = applyHelpScoutOverrides(closedList, hsOverrides([["a", "closed"]]), {
      filter: "closed",
      now: NOW,
    });
    expect(out.map((c) => c.id)).toEqual(["a"]);
    expect(out[0]!.status).toBe("closed");
  });

  it("leaves conversations it has no note for alone", () => {
    // A note for a conversation on some other page of the list must not touch
    // the rows on this one, whatever the filter says.
    const out = applyHelpScoutOverrides(conversations, hsOverrides([["zz", "closed"]]), {
      filter: "closed",
      now: NOW,
    });
    expect(out.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(out.map((c) => c.status)).toEqual(["active", "active", "pending"]);
  });

  it("drops a newly pending conversation from active but keeps it under open", () => {
    const active = applyHelpScoutOverrides(conversations, hsOverrides([["a", "pending"]]), {
      filter: "active",
      now: NOW,
    });
    expect(active.map((c) => c.id)).toEqual(["b", "c"]);

    const open = applyHelpScoutOverrides(conversations, hsOverrides([["a", "pending"]]), {
      filter: "open",
      now: NOW,
    });
    expect(open.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(open.find((c) => c.id === "a")!.status).toBe("pending");
  });

  it("does not mutate the cached conversation it rewrites", () => {
    applyHelpScoutOverrides(conversations, hsOverrides([["a", "pending"]]), {
      filter: "open",
      now: NOW,
    });
    expect(conversations[0]!.status).toBe("active");
  });

  it("ignores an expired note so the server becomes authoritative again", () => {
    const out = applyHelpScoutOverrides(
      conversations,
      hsOverrides([["a", "closed", NOW - 1]]),
      { filter: "active", now: NOW },
    );
    expect(out.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });
});

describe("isImapMessageListKey", () => {
  const scope = { pluginId: "p1", companyId: "c1", mailboxKey: "personal" };

  it("matches the list keys both pages build", () => {
    // PortfolioEmail's panel and Email.tsx build the same shape.
    expect(isImapMessageListKey(["email", "p1", "c1", "personal", "INBOX", "unseen"], scope)).toBe(
      true,
    );
    expect(isImapMessageListKey(["email", "p1", "c1", "personal", "Archive", "all"], scope)).toBe(
      true,
    );
  });

  it("leaves the sibling queries for the same mailbox alone", () => {
    // Rules, folders, and the open-message query must not be swept up.
    expect(isImapMessageListKey(["email", "p1", "c1", "personal", "rules"], scope)).toBe(false);
    expect(isImapMessageListKey(["email", "p1", "c1", "personal", "folders"], scope)).toBe(false);
    expect(isImapMessageListKey(["email", "p1", "c1", "personal", "INBOX", 42], scope)).toBe(false);
    expect(isImapMessageListKey(["email", "rulesHome", "c1", "personal"], scope)).toBe(false);
  });

  it("does not match another mailbox, company, or plugin", () => {
    expect(isImapMessageListKey(["email", "p1", "c1", "support", "INBOX", "unseen"], scope)).toBe(
      false,
    );
    expect(isImapMessageListKey(["email", "p1", "c2", "personal", "INBOX", "unseen"], scope)).toBe(
      false,
    );
    expect(isImapMessageListKey(["email", "p2", "c1", "personal", "INBOX", "unseen"], scope)).toBe(
      false,
    );
  });
});

describe("isHelpScoutListKey", () => {
  const scope = { pluginId: "p1", companyId: "c1", accountKey: "support", mailboxId: "12345" };

  it("matches every status variant", () => {
    for (const status of ["open", "active", "pending", "closed", "spam"]) {
      expect(
        isHelpScoutListKey(["helpscout", "p1", "c1", "support", "12345", status], scope),
      ).toBe(true);
    }
  });

  it("leaves the single-conversation and mailbox-list queries alone", () => {
    expect(isHelpScoutListKey(["helpscout", "p1", "c1", "support", "conv", "999"], scope)).toBe(
      false,
    );
    expect(isHelpScoutListKey(["helpscout", "p1", "c1", "list-mailboxes"], scope)).toBe(false);
  });

  it("does not match another mailbox or account", () => {
    expect(
      isHelpScoutListKey(["helpscout", "p1", "c1", "support", "67890", "active"], scope),
    ).toBe(false);
    expect(
      isHelpScoutListKey(["helpscout", "p1", "c1", "sales", "12345", "active"], scope),
    ).toBe(false);
  });
});

describe("scope keys", () => {
  it("separates folders within a mailbox, because IMAP uids are per-folder", () => {
    expect(imapMailboxScope("p1", "c1", "personal", "INBOX")).not.toBe(
      imapMailboxScope("p1", "c1", "personal", "Archive"),
    );
  });

  it("gives both email views the same scope for the same mailbox and folder", () => {
    expect(imapMailboxScope("p1", "c1", "personal", "INBOX")).toBe(
      imapMailboxScope("p1", "c1", "personal", "INBOX"),
    );
  });

  it("ignores status for Help Scout so a note survives a tab switch", () => {
    expect(helpScoutMailboxScope("p1", "c1", "support", "12345")).toBe(
      helpScoutMailboxScope("p1", "c1", "support", "12345"),
    );
  });
});

describe("override store", () => {
  const scope = imapMailboxScope("p1", "c1", "personal", "INBOX");
  const other = imapMailboxScope("p1", "c1", "support", "INBOX");

  it("starts empty and hands back a stable reference", () => {
    const first = imapOverrideStore.snapshot(scope);
    expect(first.size).toBe(0);
    expect(imapOverrideStore.snapshot(scope)).toBe(first);
  });

  it("returns the same empty map for a null scope", () => {
    expect(imapOverrideStore.snapshot(null)).toBe(imapOverrideStore.snapshot(null));
    expect(imapOverrideStore.snapshot(null).size).toBe(0);
  });

  it("records a note and dates it by the TTL", () => {
    imapOverrideStore.set(scope, 7, "read", NOW);
    const entry = imapOverrideStore.snapshot(scope).get(7);
    expect(entry).toEqual({ value: "read", expiresAt: NOW + OVERRIDE_TTL_MS });
  });

  it("keeps scopes independent", () => {
    imapOverrideStore.set(scope, 7, "read", NOW);
    expect(imapOverrideStore.snapshot(other).size).toBe(0);
  });

  it("replaces the snapshot reference on write, so subscribers re-render", () => {
    const before = imapOverrideStore.snapshot(scope);
    imapOverrideStore.set(scope, 7, "read", NOW);
    expect(imapOverrideStore.snapshot(scope)).not.toBe(before);
  });

  it("clears a single note without disturbing the others", () => {
    imapOverrideStore.set(scope, 7, "read", NOW);
    imapOverrideStore.set(scope, 8, "gone", NOW);
    imapOverrideStore.clear(scope, 7);
    expect([...imapOverrideStore.snapshot(scope).keys()]).toEqual([8]);
  });

  it("ignores a clear for a note it never had", () => {
    const before = imapOverrideStore.snapshot(scope);
    imapOverrideStore.clear(scope, 99);
    expect(imapOverrideStore.snapshot(scope)).toBe(before);
  });

  it("prunes expired notes on the next write", () => {
    imapOverrideStore.set(scope, 7, "read", NOW);
    imapOverrideStore.set(scope, 8, "gone", NOW + OVERRIDE_TTL_MS + 1);
    expect([...imapOverrideStore.snapshot(scope).keys()]).toEqual([8]);
  });

  it("notifies subscribers on write and clear, and stops after unsubscribe", () => {
    let calls = 0;
    const unsubscribe = imapOverrideStore.subscribe(() => {
      calls++;
    });
    imapOverrideStore.set(scope, 7, "read", NOW);
    imapOverrideStore.clear(scope, 7);
    expect(calls).toBe(2);
    unsubscribe();
    imapOverrideStore.set(scope, 8, "read", NOW);
    expect(calls).toBe(2);
  });

  it("defaults the clock to now when no timestamp is passed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    imapOverrideStore.set(scope, 7, "read");
    expect(imapOverrideStore.snapshot(scope).get(7)!.expiresAt).toBe(NOW + OVERRIDE_TTL_MS);
  });

  it("keeps Help Scout notes keyed by conversation id", () => {
    const hsScope = helpScoutMailboxScope("p1", "c1", "support", "12345");
    helpScoutOverrideStore.set(hsScope, "abc", "closed", NOW);
    expect(helpScoutOverrideStore.snapshot(hsScope).get("abc")!.value).toBe("closed");
  });
});
