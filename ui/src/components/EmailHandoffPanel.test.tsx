// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailHandoffPanel } from "./EmailHandoffPanel";
import type { EmailHandoff } from "@/api/emailHandoffs";

const mockApi = vi.hoisted(() => ({
  listForIssue: vi.fn(),
  acknowledge: vi.fn(),
  resolve: vi.fn(),
  handBack: vi.fn(),
}));

vi.mock("@/api/emailHandoffs", () => ({ emailHandoffsApi: mockApi }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function handoff(overrides: Partial<EmailHandoff> = {}): EmailHandoff {
  return {
    id: "handoff-1",
    issueId: "issue-1",
    companyId: "company-1",
    pluginId: "email-tools",
    sourceKey: "email:v1:msgid:email-tools:personal:%3Ca%40b%3E",
    mailbox: "personal",
    folder: null,
    messageId: "<a@b>",
    status: "delegated",
    delegatedByUserId: "user-1",
    delegatedToAgentId: null,
    delegatedAt: "2026-09-04T09:00:00.000Z",
    acknowledgedAt: null,
    resolvedAt: null,
    resolutionNote: null,
    handedBackReason: null,
    previousDelegationId: null,
    replyState: "none",
    replyError: null,
    version: 0,
    createdAt: "2026-09-04T09:00:00.000Z",
    updatedAt: "2026-09-04T09:00:00.000Z",
    ...overrides,
  };
}

describe("EmailHandoffPanel", () => {
  let container: HTMLDivElement;

  async function render() {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <EmailHandoffPanel companyId="company-1" issueId="issue-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  function buttonWith(text: string) {
    return [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockApi.listForIssue.mockResolvedValue([handoff()]);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("shows nothing on an issue that did not come from an email", async () => {
    mockApi.listForIssue.mockResolvedValue([]);
    await render();
    expect(container.textContent).toBe("");
  });

  it("says the handover is waiting to be picked up", async () => {
    await render();
    expect(container.textContent).toContain("Handed over from an email");
    expect(container.textContent).toContain("Waiting to be picked up");
    expect(container.textContent).toContain("personal");
  });

  it("warns that the reply reaches the sender before you send it", async () => {
    await render();
    await act(async () => {
      buttonWith("Finish and reply")?.click();
    });
    await flushReact();

    expect(container.textContent).toContain("This goes to whoever sent the email");
  });

  it("offers to finish without replying when nothing is written", async () => {
    await render();
    await act(async () => {
      buttonWith("Finish and reply")?.click();
    });
    await flushReact();

    // The button says which of the two things it will do, so an empty box is
    // never mistaken for "this will send something".
    expect(buttonWith("Finish without replying")).toBeTruthy();
    expect(buttonWith("Send and finish")).toBeFalsy();
  });

  it("passes the version through so a stale click is refused by the server", async () => {
    mockApi.acknowledge.mockResolvedValue(handoff({ status: "acknowledged", version: 1 }));
    await render();

    await act(async () => {
      buttonWith("Mark as picked up")?.click();
    });
    await flushReact();

    expect(mockApi.acknowledge).toHaveBeenCalledWith("company-1", "issue-1", "handoff-1", 0);
  });

  it("says a reply is waiting for you rather than implying it went", async () => {
    mockApi.listForIssue.mockResolvedValue([
      handoff({ status: "resolved", replyState: "queued" }),
    ]);
    await render();

    expect(container.textContent).toContain("waiting for you in Approvals");
    expect(container.textContent).not.toContain("Replied to the sender");
  });

  it("says plainly when a reply did not send, and why", async () => {
    mockApi.listForIssue.mockResolvedValue([
      handoff({
        status: "resolved",
        replyState: "failed",
        replyError: "Mailbox rejected the message",
      }),
    ]);
    await render();

    expect(container.textContent).toContain("The reply did not send");
    expect(container.textContent).toContain("Mailbox rejected the message");
  });

  it("shows the reason work was handed back", async () => {
    mockApi.listForIssue.mockResolvedValue([
      handoff({ status: "handed_back", handedBackReason: "Needs billing access" }),
    ]);
    await render();

    expect(container.textContent).toContain("Needs billing access");
    // Finished handovers offer no actions.
    expect(buttonWith("Finish and reply")).toBeFalsy();
  });

  it("will not let you hand back without a reason", async () => {
    await render();
    await act(async () => {
      buttonWith("Hand back")?.click();
    });
    await flushReact();

    const submit = [...container.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Hand back",
    );
    expect(submit?.disabled).toBe(true);
  });

  it("says what went wrong instead of looking like the click did nothing", async () => {
    mockApi.acknowledge.mockRejectedValue(new Error("This delegation changed while you were looking at it."));
    await render();

    await act(async () => {
      buttonWith("Mark as picked up")?.click();
    });
    await flushReact();

    expect(container.textContent).toContain("changed while you were looking at it");
  });

  it("keeps the earlier handovers visible after a re-delegation", async () => {
    mockApi.listForIssue.mockResolvedValue([
      handoff({ id: "handoff-2", status: "delegated", version: 0 }),
      handoff({
        id: "handoff-1",
        status: "handed_back",
        handedBackReason: "Wrong team",
      }),
    ]);
    await render();

    expect(container.textContent).toContain("Wrong team");
    expect(container.textContent).toContain("Waiting to be picked up");
  });
});
