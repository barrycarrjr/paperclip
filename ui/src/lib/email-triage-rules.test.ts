import { describe, expect, it } from "vitest";
import {
  buildReviewSenderGroups,
  isSenderRuled,
  type ReviewMailHeader,
} from "./email-triage-rules";

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
