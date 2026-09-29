// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Approval } from "@paperclipai/shared";
import { ApprovalCard } from "./ApprovalCard";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "outbound_tool_draft",
    requestedByAgentId: null,
    requestedByUserId: null,
    status: "pending",
    payload: {
      toolName: "slack-tools:slack_send_dm",
      parameters: { userId: "U0AAA111", text: "Is this domain still live?" },
      summary: 'to U0AAA111 "Is this domain still live?"',
      agentId: "agent-1",
      runId: "run-123",
      chatSessionId: "session-key-456",
    },
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("ApprovalCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function render(approval: Approval, props: Partial<Parameters<typeof ApprovalCard>[0]> = {}) {
    act(() => {
      root.render(
        <ApprovalCard
          approval={approval}
          requesterAgent={null}
          detailLink={`/approvals/${approval.id}`}
          {...props}
        />,
      );
    });
  }

  it("shows who a message goes to and what it says, with the raw data folded away", () => {
    render(makeApproval());

    expect(container.querySelector("h3")?.textContent).toBe("Slack DM");
    expect(container.textContent).toContain("U0AAA111");
    expect(container.querySelector("blockquote")?.textContent).toBe("Is this domain still live?");
    expect(container.textContent).not.toContain("run-123");
    expect(container.textContent).not.toContain("session-key-456");
  });

  it("opens the full request inside the card, wrapped rather than widening it", () => {
    render(makeApproval());

    const toggle = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("See full request"),
    );
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");

    act(() => {
      toggle?.click();
    });

    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toContain("run-123");
    expect(pre?.className).toContain("whitespace-pre-wrap");
    expect(pre?.className).toContain("wrap-anywhere");
    expect(pre?.className).toContain("overflow-auto");
    expect((container.firstElementChild as HTMLElement).className).toContain("min-w-0");
  });

  it("puts View details in the header, above the approve and reject buttons", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(makeApproval(), { onApprove, onReject });

    const link = container.querySelector('a[href="/approvals/approval-1"]');
    expect(link?.textContent).toBe("View details");
    const approveButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Approve",
    );
    expect(approveButton).toBeTruthy();
    expect(link!.compareDocumentPosition(approveButton!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The header block holds the title and the link together.
    expect(link!.closest(".justify-between")?.querySelector("h3")).toBeTruthy();

    const rejectButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Reject",
    );
    act(() => {
      approveButton?.click();
      rejectButton?.click();
    });
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it("keeps the summary as the title when a draft has nothing readable", () => {
    render(
      makeApproval({
        payload: {
          toolName: "kdp-tools:kdp_publish",
          parameters: { bookId: 7 },
          summary: "kdp-tools:kdp_publish",
          runId: "run-123",
        },
      }),
    );

    expect(container.querySelector("h3")?.textContent).toBe("kdp-tools:kdp_publish");
    expect(container.textContent).not.toContain("run-123");
  });
});
