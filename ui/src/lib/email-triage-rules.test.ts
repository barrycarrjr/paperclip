import { describe, expect, it, vi } from "vitest";
import {
  buildReviewSenderGroups,
  clearStoredReviewEntry,
  isMissingPluginAction,
  isSenderRuled,
  type ReviewMailHeader,
} from "./email-triage-rules";

describe("clearStoredReviewEntry", () => {
  const row = { mailbox: "personal", sender: "promo@shop.example.com" };

  it("takes the sender off the triage routine's review queue", async () => {
    const api = { dismissReviewEntry: vi.fn(async () => ({ ok: true, cleared: 1 })) };
    await clearStoredReviewEntry(api, row);
    expect(api.dismissReviewEntry).toHaveBeenCalledWith("personal", "promo@shop.example.com");
  });

  // An email-tools older than 0.20.0 has no such action. The mail is already
  // marked read, so the dismissal still stands.
  it("does not fail the dismissal when the plugin has no review queue", async () => {
    const api = {
      dismissReviewEntry: vi.fn(async () =>
        Promise.reject(new Error('No action handler registered for key "email.dismiss-review-entry"')),
      ),
    };
    await expect(clearStoredReviewEntry(api, row)).resolves.toBeUndefined();
  });

  it("passes on any other failure, so the Brief can show it", async () => {
    const api = {
      dismissReviewEntry: vi.fn(async () => Promise.reject(new Error("Mailbox \"personal\" not configured"))),
    };
    await expect(clearStoredReviewEntry(api, row)).rejects.toThrow(/not configured/);
  });

  it("does nothing without the email-tools plugin", async () => {
    await expect(clearStoredReviewEntry(null, row)).resolves.toBeUndefined();
  });

  it("recognises only the missing-action answer as an old plugin", () => {
    expect(isMissingPluginAction(new Error('No action handler registered for key "x"'))).toBe(true);
    expect(isMissingPluginAction(new Error("Request failed: 502"))).toBe(false);
    expect(isMissingPluginAction(new Error("simulated database failure"))).toBe(false);
    expect(isMissingPluginAction(undefined)).toBe(false);
  });
});

describe("buildReviewSenderGroups", () => {
  function msg(uid: number, from: string, date: string): ReviewMailHeader {
    return { uid, from, date };
  }

  it("groups unread mail by sender, noisiest first", () => {
    const groups = buildReviewSenderGroups(
      [
        msg(1, "Rollbar <notifier@mail.rollbar.com>", "2026-08-06T10:00:00Z"),
        msg(2, "Rollbar <notifier@mail.rollbar.com>", "2026-08-06T11:00:00Z"),
        msg(3, "Dana <dana@acme.test>", "2026-08-06T09:00:00Z"),
      ],
      [],
    );

    expect(groups.map((g) => [g.sender, g.count])).toEqual([
      ["notifier@mail.rollbar.com", 2],
      ["dana@acme.test", 1],
    ]);
  });

  it("puts the newest message first, so the preview is the latest one", () => {
    const [group] = buildReviewSenderGroups(
      [
        msg(1, "a@b.test", "2026-08-06T10:00:00Z"),
        msg(2, "a@b.test", "2026-08-06T12:00:00Z"),
        msg(3, "a@b.test", "2026-08-06T11:00:00Z"),
      ],
      [],
    );
    expect(group!.messages.map((m) => m.uid)).toEqual([2, 3, 1]);
  });

  it("leaves out senders a rule already covers", () => {
    // A rule is the answer to "stop asking me about this", so a sender with
    // one is not waiting on anybody.
    const groups = buildReviewSenderGroups(
      [msg(1, "a@b.test", "2026-08-06T10:00:00Z"), msg(2, "c@d.test", "2026-08-06T10:00:00Z")],
      [{ senderPattern: "A@B.TEST" }],
    );
    expect(groups.map((g) => g.sender)).toEqual(["c@d.test"]);
  });

  it("honours a whole-domain rule", () => {
    const groups = buildReviewSenderGroups(
      [msg(1, "anyone@noisy.test", "2026-08-06T10:00:00Z")],
      [{ senderPattern: "@noisy.test" }],
    );
    expect(groups).toEqual([]);
  });

  it("keeps a sender whose address cannot be read, rather than losing it", () => {
    const groups = buildReviewSenderGroups(
      [msg(1, "Mailer Daemon", "2026-08-06T10:00:00Z")],
      [],
    );
    expect(groups.map((g) => g.sender)).toEqual(["mailer daemon"]);
  });

  it("is empty when the mailbox is", () => {
    expect(buildReviewSenderGroups([], [{ senderPattern: "a@b.test" }])).toEqual([]);
  });
});

describe("isSenderRuled", () => {
  it("matches the exact address and its domain, case-insensitively", () => {
    expect(isSenderRuled("Foo@Bar.test", new Set(["foo@bar.test"]))).toBe(true);
    expect(isSenderRuled("foo@bar.test", new Set(["@bar.test"]))).toBe(true);
    expect(isSenderRuled("foo@bar.test", new Set(["@other.test"]))).toBe(false);
  });

  it("does not treat a bare name as a domain match", () => {
    expect(isSenderRuled("mailer daemon", new Set(["@bar.test"]))).toBe(false);
  });
});
