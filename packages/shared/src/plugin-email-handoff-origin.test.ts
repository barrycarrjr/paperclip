import { describe, expect, it } from "vitest";
import { buildEmailHandoffOriginId } from "./email-handoff-origin.js";
import { canonicalizePluginEmailHandoffOrigin } from "./plugin-email-handoff-origin.js";

const pluginId = "00000000-0000-4000-8000-000000000083";
const base = { pluginKey: "email-tools", pluginId, assigneeAgentId: "example-agent",
  originId: buildEmailHandoffOriginId({ pluginId: "email-tools", mailbox: "shared", messageId: "<example:83@example.com>" }) };

describe("plugin email handoff origin contract", () => {
  it("canonicalizes a self key to the installed database id, retaining encoded Message-ID punctuation", () => {
    expect(canonicalizePluginEmailHandoffOrigin(base)).toEqual({
      source: { kind: "msgid", pluginId, mailbox: "shared", messageId: "<example:83@example.com>" },
      originId: buildEmailHandoffOriginId({ pluginId, mailbox: "shared", messageId: "<example:83@example.com>" }),
    });
  });
  it.each([
    "email:v1:msgid:email-tools:%ZZ:%3Cexample%40example.com%3E",
    "email:v1:msgid:email-tools:%00:%3Cexample%40example.com%3E",
    "email:v1:msgid:email-tools:shared:%3Cexample%40example.com%3E%0A",
    "email:v1:msgid:email-tools:shared:%3Cexample%3E",
    "email:v1:uid:email-tools:shared:INBOX:1",
    "email:v1:uid:email-tools:shared:INBOX:-1",
  ])("refuses unsafe source identity: %s", (originId) => {
    expect(() => canonicalizePluginEmailHandoffOrigin({ ...base, originId })).toThrow();
  });
});
