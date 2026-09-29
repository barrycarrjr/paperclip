// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OUTBOUND_SELF_RECIPIENT_RULES } from "@paperclipai/shared";
import { ApprovalPayloadRenderer, approvalLabel, outboundDraftPreview } from "./ApprovalPayload";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("approvalLabel", () => {
  it("uses payload titles for generic board approvals", () => {
    expect(
      approvalLabel("request_board_approval", {
        title: "Reply with an ASCII frog",
      }),
    ).toBe("Board Approval: Reply with an ASCII frog");
  });
});

describe("outboundDraftPreview", () => {
  it("reads the Slack user and message from a DM draft", () => {
    expect(
      outboundDraftPreview({
        toolName: "slack-tools:slack_send_dm",
        parameters: { userId: "U0AAA111", text: "Is this domain still live?" },
        runId: "run-1",
      }),
    ).toEqual({
      recipient: "U0AAA111",
      cc: null,
      bcc: null,
      subject: null,
      message: "Is this domain still live?",
      extras: [],
    });
  });

  it("says a Slack DM with no user goes to you", () => {
    expect(
      outboundDraftPreview({
        toolName: "slack-tools:slack_send_dm",
        parameters: { text: "Sweep done." },
      })?.recipient,
    ).toBe("You");
  });

  it("ignores fields a Slack DM does not read", () => {
    // The worker reads only userId, so a stray channel or `to` still sends
    // to the default DM target.
    expect(
      outboundDraftPreview({
        toolName: "slack-tools:slack_send_dm",
        parameters: { channel: "D0SOMEONE", to: "U0STRAY", text: "hi" },
      })?.recipient,
    ).toBe("You");
    expect(
      outboundDraftPreview({
        toolName: "slack-tools:slack_send_dm",
        parameters: { recipient: "U0STRAY", userId: "U0AAA111", text: "hi" },
      })?.recipient,
    ).toBe("U0AAA111");
  });

  it("shows the channel id over the channel name, as the Slack worker does", () => {
    expect(
      outboundDraftPreview({
        toolName: "slack-tools:slack_send_channel",
        parameters: { channelName: "ops", channelId: "C0GENERAL", text: "hello ops" },
      })?.recipient,
    ).toBe("C0GENERAL");
    expect(
      outboundDraftPreview({
        toolName: "slack-tools:slack_send_channel",
        parameters: { channelName: "#ops", text: "hello ops" },
      })?.recipient,
    ).toBe("#ops");
  });

  it("says a channel post with no channel goes to the default channel", () => {
    expect(
      outboundDraftPreview({
        toolName: "slack-tools:slack_send_channel",
        parameters: { text: "hello" },
      })?.recipient,
    ).toBe("Default channel");
  });

  it("reads email recipients, subject and body", () => {
    expect(
      outboundDraftPreview({
        toolName: "email-tools:email_send",
        parameters: {
          mailbox: "personal",
          to: ["a@example.com", "b@example.com"],
          subject: "Quote",
          body: "Here is the quote.",
        },
      }),
    ).toEqual({
      recipient: "a@example.com, b@example.com",
      cc: null,
      bcc: null,
      subject: "Quote",
      message: "Here is the quote.",
      extras: [],
    });
  });

  it("reads email cc and bcc", () => {
    expect(
      outboundDraftPreview({
        toolName: "email-tools:email_send",
        parameters: {
          to: "a@example.com",
          cc: "c@example.com",
          bcc: ["hidden@example.com", "other@example.com"],
          subject: "Quote",
          body: "Here is the quote.",
        },
      }),
    ).toMatchObject({
      recipient: "a@example.com",
      cc: "c@example.com",
      bcc: "hidden@example.com, other@example.com",
    });
  });

  it("shows every recipient field the server checks for self-notification", () => {
    // Guards against the UI and OUTBOUND_SELF_RECIPIENT_RULES drifting apart:
    // a recipient the server counts must also be visible to the approver.
    for (const [toolName, rule] of Object.entries(OUTBOUND_SELF_RECIPIENT_RULES)) {
      for (const param of rule!.recipientParams) {
        const address = `${param}-address`;
        const preview = outboundDraftPreview({ toolName, parameters: { [param]: address, text: "hi" } });
        expect([preview?.recipient, preview?.cc, preview?.bcc], `${toolName} ${param}`).toContain(address);
      }
    }
  });

  it("reads the Help Scout reply's customer, cc and bcc", () => {
    expect(
      outboundDraftPreview({
        toolName: "help-scout:helpscout_send_reply",
        parameters: {
          conversationId: "123",
          body: "Thanks for waiting.",
          cc: ["c@example.com"],
          bcc: ["hidden@example.com"],
        },
      }),
    ).toMatchObject({
      recipient: "The conversation's customer",
      cc: "c@example.com",
      bcc: "hidden@example.com",
      message: "Thanks for waiting.",
    });
    expect(
      outboundDraftPreview({
        toolName: "help-scout:helpscout_send_reply",
        parameters: { conversationId: "123", body: "Hi", customerEmail: "x@example.com", customerId: 42 },
      })?.recipient,
    ).toBe("Help Scout customer 42");
  });

  it("lists what the quote leaves out", () => {
    expect(
      outboundDraftPreview({
        toolName: "slack-tools:slack_send_channel",
        parameters: { channelId: "C01", text: "fallback", blocks: [{ type: "section" }], asUser: true },
      })?.extras,
    ).toEqual(["formatted Slack blocks", "sent from your own Slack account"]);
    expect(
      outboundDraftPreview({
        toolName: "email-tools:email_send",
        parameters: {
          to: "a@example.com",
          body: "plain",
          body_html: "<p>plain</p>",
          attachments: [{ name: "a.pdf" }, { name: "b.pdf" }],
        },
      })?.extras,
    ).toEqual(["an HTML version", "2 attachments"]);
    // The same field names mean nothing on tools that do not read them.
    expect(
      outboundDraftPreview({
        toolName: "phone-tools:phone_call_make",
        parameters: { to: "+15551234567", message: "hi", asUser: true, blocks: [{}], body_html: "<p/>" },
      })?.extras,
    ).toEqual([]);
  });

  it("returns null when the draft has nothing readable", () => {
    expect(outboundDraftPreview({ toolName: "kdp-tools:kdp_publish", parameters: { bookId: 7 } })).toBeNull();
    expect(outboundDraftPreview({ toolName: "slack-tools:slack_send_dm" })).toBeNull();
    expect(outboundDraftPreview(null)).toBeNull();
  });
});

describe("ApprovalPayloadRenderer", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders request_board_approval payload fields without falling back to raw JSON", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          payload={{
            title: "Reply with an ASCII frog",
            summary: "Board asked for approval before posting the frog.",
            recommendedAction: "Approve the frog reply.",
            nextActionOnApproval: "Post the frog comment on the issue.",
            risks: ["The frog might be too powerful."],
            proposedComment: "(o)<",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Reply with an ASCII frog");
    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).toContain("Approve the frog reply.");
    expect(container.textContent).toContain("Post the frog comment on the issue.");
    expect(container.textContent).toContain("The frog might be too powerful.");
    expect(container.textContent).toContain("(o)<");
    expect(container.textContent).not.toContain("\"recommendedAction\"");

    act(() => {
      root.unmount();
    });
  });

  it("can hide the repeated title when the card header already shows it", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          hidePrimaryTitle
          payload={{
            title: "Reply with an ASCII frog",
            summary: "Board asked for approval before posting the frog.",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).not.toContain("TitleReply with an ASCII frog");

    act(() => {
      root.unmount();
    });
  });

  it("shows an outbound draft's recipient and message instead of its raw data", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="outbound_tool_draft"
          compact
          payload={{
            toolName: "slack-tools:slack_send_dm",
            parameters: { userId: "U0AAA111", text: "Is this domain still live?" },
            runId: "run-123",
            chatSessionId: "session-key-456",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("To");
    expect(container.textContent).toContain("U0AAA111");
    expect(container.querySelector("blockquote")?.textContent).toBe("Is this domain still live?");
    expect(container.textContent).not.toContain("run-123");
    expect(container.textContent).not.toContain("session-key-456");

    act(() => {
      root.unmount();
    });
  });

  it("shows an email's cc, bcc and what the quote leaves out", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="outbound_tool_draft"
          compact
          payload={{
            toolName: "email-tools:email_send",
            parameters: {
              to: "a@example.com",
              cc: "c@example.com",
              bcc: "hidden@example.com",
              subject: "Quote",
              body: "Here is the quote.",
              attachments: [{ name: "quote.pdf" }],
            },
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Cc");
    expect(container.textContent).toContain("c@example.com");
    expect(container.textContent).toContain("Bcc");
    expect(container.textContent).toContain("hidden@example.com");
    expect(container.textContent).toContain('Also: 1 attachment. Open "See full request" to check.');

    act(() => {
      root.unmount();
    });
  });

  it("leaves raw JSON out of the compact view when there is nothing readable", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="outbound_tool_draft"
          compact
          payload={{ toolName: "kdp-tools:kdp_publish", parameters: { bookId: 7 }, runId: "run-123" }}
        />,
      );
    });

    expect(container.querySelector("pre")).toBeNull();
    expect(container.textContent).not.toContain("run-123");

    act(() => {
      root.unmount();
    });
  });
});
