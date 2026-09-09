import { describe, expect, it } from "vitest";
import {
  EMAIL_HANDOFF_ORIGIN_KIND,
  buildEmailHandoffOriginId,
  isEmailHandoffOriginKind,
  parseEmailHandoffOriginId,
} from "./email-handoff-origin.js";

describe("buildEmailHandoffOriginId", () => {
  it("prefers the provider Message-Id, which survives the message being moved", () => {
    const id = buildEmailHandoffOriginId({
      pluginId: "plugin-1",
      mailbox: "personal",
      messageId: "<abc@example.com>",
      folder: "INBOX",
      uid: 42,
    });

    expect(id).toBe("email:v1:msgid:plugin-1:personal:%3Cabc%40example.com%3E");
    expect(parseEmailHandoffOriginId(id)).toEqual({
      kind: "msgid",
      pluginId: "plugin-1",
      mailbox: "personal",
      messageId: "<abc@example.com>",
    });
  });

  it("falls back to mailbox/folder/uid when the provider gives no Message-Id", () => {
    const id = buildEmailHandoffOriginId({
      pluginId: "plugin-1",
      mailbox: "personal",
      messageId: null,
      folder: "INBOX",
      uid: 42,
    });

    expect(id).toBe("email:v1:uid:plugin-1:personal:INBOX:42");
    expect(parseEmailHandoffOriginId(id)).toEqual({
      kind: "uid",
      pluginId: "plugin-1",
      mailbox: "personal",
      folder: "INBOX",
      uid: 42,
    });
  });

  it("survives a colon inside a Message-Id instead of corrupting the key", () => {
    // Legal in a Message-Id, and the reason every component is encoded.
    const id = buildEmailHandoffOriginId({
      pluginId: "plugin-1",
      mailbox: "personal",
      messageId: "<a:b@example.com>",
    });

    expect(parseEmailHandoffOriginId(id)).toEqual({
      kind: "msgid",
      pluginId: "plugin-1",
      mailbox: "personal",
      messageId: "<a:b@example.com>",
    });
  });

  it("survives a colon in the mailbox key too (Help Scout ids are not bare words)", () => {
    const id = buildEmailHandoffOriginId({
      pluginId: "plugin-1",
      mailbox: "helpscout:acct-9:mailbox-3",
      messageId: "<m1>",
    });

    expect(parseEmailHandoffOriginId(id)?.mailbox).toBe("helpscout:acct-9:mailbox-3");
  });

  it("returns null rather than a meaningless key when the source can't be identified", () => {
    // No Message-Id and no usable uid — the caller decides whether to hand off
    // without a durable reference, rather than storing something unparseable.
    expect(
      buildEmailHandoffOriginId({ pluginId: "plugin-1", mailbox: "personal", folder: "INBOX" }),
    ).toBeNull();
    expect(
      buildEmailHandoffOriginId({ pluginId: "", mailbox: "personal", messageId: "<m1>" }),
    ).toBeNull();
    expect(
      buildEmailHandoffOriginId({ pluginId: "plugin-1", mailbox: "  ", messageId: "<m1>" }),
    ).toBeNull();
  });
});

describe("parseEmailHandoffOriginId", () => {
  it("rejects anything that isn't one of our keys", () => {
    expect(parseEmailHandoffOriginId(null)).toBeNull();
    expect(parseEmailHandoffOriginId("")).toBeNull();
    // A routine execution's originId is a bare uuid — must not be mistaken
    // for an email reference.
    expect(parseEmailHandoffOriginId("2f1c5a80-0000-4000-8000-000000000000")).toBeNull();
    expect(parseEmailHandoffOriginId("email:v2:msgid:p:m:x")).toBeNull();
    expect(parseEmailHandoffOriginId("email:v1:other:p:m:x")).toBeNull();
    expect(parseEmailHandoffOriginId("email:v1:msgid:p:m")).toBeNull();
    expect(parseEmailHandoffOriginId("email:v1:uid:p:m:INBOX:notanumber")).toBeNull();
  });
});

describe("isEmailHandoffOriginKind", () => {
  it("matches only the email handoff kind", () => {
    expect(isEmailHandoffOriginKind(EMAIL_HANDOFF_ORIGIN_KIND)).toBe(true);
    expect(isEmailHandoffOriginKind("routine_execution")).toBe(false);
    expect(isEmailHandoffOriginKind("manual")).toBe(false);
    expect(isEmailHandoffOriginKind(null)).toBe(false);
  });
});
