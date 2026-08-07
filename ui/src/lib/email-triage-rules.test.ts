import { describe, expect, it } from "vitest";
import {
  buildReviewSenderGroups,
  dismissReviewSender,
  graduateSender,
  isSenderRuled,
  keepAlwaysSender,
  parseReviewQueue,
  type ReviewMailHeader,
} from "./email-triage-rules";

const PERSONAL_FORMAT = `# rules
## Auto-triage senders

emails@pro.crexi.com

## Keep-always senders

alerts@td.com

## Review queue

5 messages from no-reply@nextdoor.com
2 messages from info@coversandall.com
`;

// Matches the format the IND/M3/C3 COOs have been writing.
const BULLETED_RICH_FORMAT = `# rules
## Auto-triage senders

- abc@someemail.net

## Keep-always senders

## Review queue

<!-- Added by COO routine run -->
- no-reply@rs.email.nextdoor.com | Nextdoor neighborhood post digest | likely auto-triage candidate
- info@coversandall.com | CoversAndAll promotional emails | likely auto-triage candidate
- 6 messages from no-reply@pbslabelsolutions.com
`;

// Matches a third format some agents have drifted into, using em-dash
// instead of pipe as the separator.
const EMDASH_FORMAT = `# rules
## Auto-triage senders

## Keep-always senders

## Review queue

<!-- Added 2026-05-11 by COO routine run -->
- compass@autoprint-software.atlassian.net — Atlassian Compass weekly digest. **Recommend: Auto-triage**.
- no-reply@vantage.sh — Vantage cloud cost report (weekly). **Recommend: Auto-triage**.
- 4 messages from no-reply@example.com — Mixed counted + em-dash format
`;

describe("parseReviewQueue", () => {
  it("parses the canonical Personal '<count> messages from <sender>' format", () => {
    expect(parseReviewQueue(PERSONAL_FORMAT)).toEqual([
      { count: 5, sender: "no-reply@nextdoor.com" },
      { count: 2, sender: "info@coversandall.com" },
    ]);
  });

  it("parses the bulleted '- <sender> | <desc> | <rec>' format the other COOs use", () => {
    const entries = parseReviewQueue(BULLETED_RICH_FORMAT);
    // sorted by count desc; the bullet+pipe entries default to count 1
    expect(entries).toEqual([
      { count: 6, sender: "no-reply@pbslabelsolutions.com" },
      { count: 1, sender: "no-reply@rs.email.nextdoor.com" },
      { count: 1, sender: "info@coversandall.com" },
    ]);
  });

  it("parses em-dash separator format (newer COO drift)", () => {
    const entries = parseReviewQueue(EMDASH_FORMAT);
    // Count = 4 sorts first; the two em-dash entries default to 1.
    expect(entries).toEqual([
      { count: 4, sender: "no-reply@example.com" },
      { count: 1, sender: "compass@autoprint-software.atlassian.net" },
      { count: 1, sender: "no-reply@vantage.sh" },
    ]);
  });

  it("ignores comments, blank lines, and the placeholder hint line", () => {
    const body = `## Review queue

<!-- Added by COO routine run -->

\`<count> messages from <sender>\`
`;
    expect(parseReviewQueue(body)).toEqual([]);
  });
});

describe("review-queue mutations", () => {
  it("adds sender with bullet prefix when graduating", () => {
    const next = graduateSender(BULLETED_RICH_FORMAT, "no-reply@rs.email.nextdoor.com");
    const autoSection = next.slice(
      next.indexOf("## Auto-triage senders"),
      next.indexOf("## Keep-always senders"),
    );
    expect(autoSection).toContain("- no-reply@rs.email.nextdoor.com");
    // not added without bullet
    expect(autoSection).not.toMatch(/^[^-].*no-reply@rs\.email\.nextdoor\.com/m);
  });

  it("adds sender with bullet prefix when keeping always", () => {
    const next = keepAlwaysSender(PERSONAL_FORMAT, "no-reply@nextdoor.com");
    const keepSection = next.slice(next.indexOf("## Keep-always senders"));
    expect(keepSection).toContain("- no-reply@nextdoor.com");
  });

  it("removes bulleted-rich entries when graduating a sender", () => {
    const next = graduateSender(BULLETED_RICH_FORMAT, "no-reply@rs.email.nextdoor.com");
    // dropped from Review queue (the bulleted+piped line is gone)
    const reviewSectionStart = next.indexOf("## Review queue");
    expect(next.slice(reviewSectionStart)).not.toContain("Nextdoor neighborhood post digest");
  });

  it("removes counted Personal-format entries when keeping a sender", () => {
    const next = keepAlwaysSender(PERSONAL_FORMAT, "no-reply@nextdoor.com");
    expect(next).toContain("## Keep-always senders");
    // verify the Review-queue line for that sender was removed
    const reviewSectionStart = next.indexOf("## Review queue");
    expect(next.slice(reviewSectionStart)).not.toContain("no-reply@nextdoor.com");
  });

  it("does not duplicate a sender already present with a bullet prefix", () => {
    const base = graduateSender(BULLETED_RICH_FORMAT, "no-reply@rs.email.nextdoor.com");
    const again = graduateSender(base, "no-reply@rs.email.nextdoor.com");
    const autoSection = again.slice(
      again.indexOf("## Auto-triage senders"),
      again.indexOf("## Keep-always senders"),
    );
    const count = (autoSection.match(/no-reply@rs\.email\.nextdoor\.com/g) ?? []).length;
    expect(count).toBe(1);
  });

  it("dismisses without adding the sender to any other section", () => {
    const next = dismissReviewSender(BULLETED_RICH_FORMAT, "info@coversandall.com");
    const auto = next.slice(next.indexOf("## Auto-triage senders"), next.indexOf("## Keep-always"));
    expect(auto).not.toContain("info@coversandall.com");
    const review = next.slice(next.indexOf("## Review queue"));
    expect(review).not.toContain("info@coversandall.com");
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
