import { describe, expect, it } from "vitest";
import type { MailHeader, ParsedEmailMessage, SearchHit } from "../../api/emailTools";
import { resolveActionHeader } from "./emailActionHeader";

function row(overrides: Partial<MailHeader> = {}): MailHeader {
  return {
    uid: 42,
    messageId: "<m1>",
    from: "sender@example.com",
    subject: "Quarterly numbers",
    date: "2026-08-01T10:00:00.000Z",
    snippet: "The numbers are",
    unseen: true,
    ...overrides,
  };
}

function hit(overrides: Partial<SearchHit> = {}): SearchHit {
  return { ...row(), mailbox: "personal", folder: "INBOX", ...overrides };
}

function parsed(overrides: Partial<ParsedEmailMessage> = {}): ParsedEmailMessage {
  return {
    uid: 42,
    messageId: "<m1>",
    inReplyTo: null,
    references: [],
    from: "sender@example.com",
    fromAddress: "sender@example.com",
    to: ["me@example.com"],
    cc: [],
    subject: "Quarterly numbers",
    date: "2026-08-01T10:00:00.000Z",
    text: "The numbers are attached.",
    html: "",
    markdown: "The numbers are attached.",
    attachments: [],
    ...overrides,
  };
}

const HERE = { mailbox: "personal", folder: "INBOX" };

describe("resolveActionHeader", () => {
  it("has nothing to act on when no message is open", () => {
    expect(resolveActionHeader({ uid: null, listRows: [row()], openMessage: parsed() })).toBeNull();
  });

  it("prefers the list row, which carries the real seen flag", () => {
    const header = resolveActionHeader({
      uid: 42,
      listRows: [row({ unseen: false })],
      openMessage: parsed(),
      assumeUnseen: true,
    });

    expect(header?.unseen).toBe(false);
    expect(header?.snippet).toBe("The numbers are");
  });

  it("falls back to a search hit when the folder list does not have the row", () => {
    const header = resolveActionHeader({
      uid: 42,
      listRows: [],
      searchHits: [hit()],
      location: HERE,
      openMessage: parsed(),
    });

    expect(header).toMatchObject({ uid: 42, unseen: true, snippet: "The numbers are" });
  });

  it("ignores a search hit for the same uid in another folder", () => {
    // IMAP uids are per-folder, so uid 42 in Archive is a different message
    // from uid 42 in INBOX and acting on it would hit the wrong mail.
    const header = resolveActionHeader({
      uid: 42,
      listRows: [],
      searchHits: [hit({ folder: "Archive", subject: "Something else" })],
      location: HERE,
      openMessage: parsed(),
      assumeUnseen: true,
    });

    expect(header?.subject).toBe("Quarterly numbers");
    expect(header?.snippet).toBe("");
  });

  it("rebuilds the row from the open message when no list holds it", () => {
    const header = resolveActionHeader({
      uid: 42,
      listRows: [row({ uid: 7 })],
      searchHits: [],
      location: HERE,
      openMessage: parsed(),
      assumeUnseen: true,
    });

    expect(header).toEqual({
      uid: 42,
      messageId: "<m1>",
      from: "sender@example.com",
      subject: "Quarterly numbers",
      date: "2026-08-01T10:00:00.000Z",
      snippet: "",
      unseen: true,
    });
  });

  it("takes the assumed seen state from the caller", () => {
    const header = resolveActionHeader({
      uid: 42,
      openMessage: parsed(),
      assumeUnseen: false,
    });

    expect(header?.unseen).toBe(false);
  });

  it("treats a rebuilt row as read when the caller says nothing", () => {
    expect(resolveActionHeader({ uid: 42, openMessage: parsed() })?.unseen).toBe(false);
  });

  it("does not act on a stale message left over from the previous selection", () => {
    expect(resolveActionHeader({ uid: 99, openMessage: parsed({ uid: 42 }) })).toBeNull();
  });

  it("has nothing to act on before the message arrives", () => {
    expect(resolveActionHeader({ uid: 42, listRows: [], openMessage: null })).toBeNull();
  });
});
