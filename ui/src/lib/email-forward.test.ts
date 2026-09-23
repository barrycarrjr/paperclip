import { describe, expect, it } from "vitest";
import { forwardOfFor } from "./email-forward";
import { imapMessageKey, isImapMessageListKey } from "./mailboxTriageOverrides";

const SOURCE = { mailbox: "m3-barry", folder: "INBOX", messageId: "<m1@x>" };

describe("forwardOfFor", () => {
  it("names the forwarded message, with its Message-ID, while still in its mailbox", () => {
    expect(forwardOfFor({ mode: "forward", sourceUid: 42, source: SOURCE, sendingMailbox: "m3-barry" })).toEqual({
      uid: 42,
      folder: "INBOX",
      messageId: "<m1@x>",
    });
  });

  it("names nothing once the page has moved to another mailbox, where the uid means another message", () => {
    expect(forwardOfFor({ mode: "forward", sourceUid: 42, source: SOURCE, sendingMailbox: "ib-barry" })).toBeNull();
  });

  it("names nothing for a new message or a forward without a real uid", () => {
    expect(forwardOfFor({ mode: "new", sourceUid: 42, source: SOURCE, sendingMailbox: "m3-barry" })).toBeNull();
    expect(forwardOfFor({ mode: "forward", sourceUid: null, source: SOURCE, sendingMailbox: "m3-barry" })).toBeNull();
    expect(forwardOfFor({ mode: "forward", sourceUid: Number.NaN, source: SOURCE, sendingMailbox: "m3-barry" })).toBeNull();
    expect(forwardOfFor({ mode: "forward", sourceUid: 42, source: null, sendingMailbox: "m3-barry" })).toBeNull();
  });

  it("leaves the Message-ID off when the message had none", () => {
    expect(
      forwardOfFor({ mode: "forward", sourceUid: 42, source: { ...SOURCE, messageId: null }, sendingMailbox: "m3-barry" }),
    ).toEqual({ uid: 42, folder: "INBOX" });
  });
});

describe("imapMessageKey", () => {
  it("is the key a list refresh does not reach, which is why a reply refreshes it separately", () => {
    const key = imapMessageKey("p1", "c1", "m3-barry", "INBOX", 42);
    expect(key).toEqual(["email", "p1", "c1", "m3-barry", "INBOX", 42]);
    expect(isImapMessageListKey(key, { pluginId: "p1", companyId: "c1", mailboxKey: "m3-barry" })).toBe(false);
  });
});
