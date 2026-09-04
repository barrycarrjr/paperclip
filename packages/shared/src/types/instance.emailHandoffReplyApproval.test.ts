import { describe, expect, it } from "vitest";
import {
  DEFAULT_EMAIL_HANDOFF_REPLY_APPROVAL,
  emailHandoffReplyNeedsApproval,
} from "./instance.js";

describe("emailHandoffReplyNeedsApproval", () => {
  it("defaults to inheriting the outbound hold", () => {
    expect(DEFAULT_EMAIL_HANDOFF_REPLY_APPROVAL).toBe("inherit");
  });

  it("inherit follows the outbound hold in both directions", () => {
    expect(
      emailHandoffReplyNeedsApproval({
        outboundToolDraftMode: true,
        emailHandoffReplyApproval: "inherit",
      }),
    ).toBe(true);
    expect(
      emailHandoffReplyNeedsApproval({
        outboundToolDraftMode: false,
        emailHandoffReplyApproval: "inherit",
      }),
    ).toBe(false);
  });

  it("always holds the reply even when nothing else is held", () => {
    expect(
      emailHandoffReplyNeedsApproval({
        outboundToolDraftMode: false,
        emailHandoffReplyApproval: "always",
      }),
    ).toBe(true);
  });

  it("never sends the reply even when everything else is held", () => {
    expect(
      emailHandoffReplyNeedsApproval({
        outboundToolDraftMode: true,
        emailHandoffReplyApproval: "never",
      }),
    ).toBe(false);
  });

  // The dangerous direction is answering "no approval needed" for a message
  // that goes to a customer, so every unclear input has to land on true.
  it("falls back to requiring approval when the value is missing or junk", () => {
    expect(emailHandoffReplyNeedsApproval({})).toBe(true);
    expect(emailHandoffReplyNeedsApproval({ outboundToolDraftMode: true })).toBe(true);
    expect(
      emailHandoffReplyNeedsApproval({ emailHandoffReplyApproval: "nonsense" }),
    ).toBe(true);
    expect(
      emailHandoffReplyNeedsApproval({
        outboundToolDraftMode: null,
        emailHandoffReplyApproval: null,
      }),
    ).toBe(true);
  });

  it("an unrecognised value does not silently become 'never'", () => {
    // A settings row written by a newer build, or hand-edited, must not be
    // able to turn the review step off by accident.
    expect(
      emailHandoffReplyNeedsApproval({
        outboundToolDraftMode: true,
        emailHandoffReplyApproval: "Never",
      }),
    ).toBe(true);
  });
});
