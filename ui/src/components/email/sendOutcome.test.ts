import { describe, expect, it } from "vitest";
import { sendOutcomeText } from "./sendOutcome";

describe("sendOutcomeText", () => {
  it("is the plain success when the copy was saved and the original marked", () => {
    expect(
      sendOutcomeText("Reply sent", {
        ok: true,
        messageId: "<r1>",
        sentCopy: { ok: true, folder: "INBOX.Sent Items" },
        original: { ok: true, flag: "\\Answered", folder: "INBOX", uid: 42 },
      }),
    ).toEqual({ text: "Reply sent", warn: false });
  });

  it("stays quiet about a provider that keeps its own copy", () => {
    expect(
      sendOutcomeText("Message sent", { ok: true, messageId: "<m>", sentCopy: { ok: true, filedBy: "Gmail" } }),
    ).toEqual({ text: "Message sent", warn: false });
  });

  it("stays quiet with an older plugin that reports neither", () => {
    expect(sendOutcomeText("Forwarded", { ok: true, messageId: "<f>" })).toEqual({
      text: "Forwarded",
      warn: false,
    });
    expect(sendOutcomeText("Forwarded", undefined)).toEqual({ text: "Forwarded", warn: false });
  });

  it("leads with the send and then says the copy is missing, so nobody sends it twice", () => {
    const outcome = sendOutcomeText("Reply sent", {
      ok: true,
      messageId: "<r1>",
      sentCopy: { ok: false, error: "This mailbox has no Sent folder." },
    });
    expect(outcome.warn).toBe(true);
    expect(outcome.text).toBe(
      "Reply sent, but no copy was saved in your Sent folder (This mailbox has no Sent folder.)",
    );
  });

  it("says which mark was not set, and joins two problems into one line", () => {
    const outcome = sendOutcomeText("Forwarded", {
      ok: true,
      messageId: "<f>",
      sentCopy: { ok: false, error: "IMAP down" },
      original: { ok: false, flag: "$Forwarded", folder: "INBOX", uid: 7, error: "flag not stored" },
    });
    expect(outcome.text).toBe(
      "Forwarded, but no copy was saved in your Sent folder (IMAP down) and the original was not marked forwarded (flag not stored)",
    );
  });

  it("does not warn about a copy or mark still on its way when the send answered", () => {
    expect(
      sendOutcomeText("Forwarded with 1 attachment", {
        ok: true,
        messageId: "<f>",
        sentCopy: { ok: false, pending: true },
        original: { ok: false, pending: true, flag: "$Forwarded", folder: "INBOX", uid: 7 },
      }),
    ).toEqual({ text: "Forwarded with 1 attachment", warn: false });
  });

  it("does not warn on every forward about a server that can never keep the forwarded mark", () => {
    expect(
      sendOutcomeText("Forwarded", {
        ok: true,
        messageId: "<f>",
        sentCopy: { ok: true, folder: "Sent Items" },
        original: {
          ok: false,
          unsupported: true,
          flag: "$Forwarded",
          folder: "INBOX",
          uid: 7,
          error: "The mail server does not store the $Forwarded flag.",
        },
      }).warn,
    ).toBe(false);
  });

  it("does not warn about an original it only looked for by Message-ID and did not find", () => {
    expect(
      sendOutcomeText("Message sent", {
        ok: true,
        messageId: "<m>",
        sentCopy: { ok: true, folder: "Sent" },
        original: { ok: false, flag: "\\Answered", folder: "INBOX", notFound: true, error: "not here" },
      }).warn,
    ).toBe(false);
  });
});
