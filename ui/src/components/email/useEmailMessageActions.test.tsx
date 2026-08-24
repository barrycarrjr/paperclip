// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailHeader, ParsedEmailMessage } from "../../api/emailTools";
import { useEmailMessageActions, type EmailMessageActionHooks } from "./useEmailMessageActions";

const mockApi = vi.hoisted(() => ({
  markRead: vi.fn(),
  markUnread: vi.fn(),
  deleteMessage: vi.fn(),
  moveMessage: vi.fn(),
  sendReply: vi.fn(),
  sendNew: vi.fn(),
  getAttachment: vi.fn(),
}));

vi.mock("../../api/emailTools", () => ({
  makeEmailToolsApi: () => mockApi,
}));

const mockIssuesApi = vi.hoisted(() => ({ create: vi.fn() }));
const mockAgentsApi = vi.hoisted(() => ({ wakeup: vi.fn() }));
vi.mock("../../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("../../api/agents", () => ({ agentsApi: mockAgentsApi }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const TARGET = { pluginId: "p1", companyId: "c1", mailbox: "personal", folder: "INBOX" };

function header(overrides: Partial<MailHeader> = {}): MailHeader {
  return {
    uid: 42,
    messageId: "<m1>",
    from: "sender@example.com",
    subject: "Quarterly numbers",
    date: "2026-08-01T10:00:00.000Z",
    snippet: "",
    unseen: true,
    ...overrides,
  };
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

let container: HTMLDivElement | null = null;
let root: Root | null = null;
type Actions = ReturnType<typeof useEmailMessageActions>;

function mountActions(hooks: EmailMessageActionHooks = {}) {
  const captured: { current: Actions | null } = { current: null };
  function Probe() {
    captured.current = useEmailMessageActions(TARGET, hooks);
    return null;
  }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  return captured;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
  mockIssuesApi.create.mockReset();
  mockAgentsApi.wakeup.mockReset();
  mockApi.markRead.mockResolvedValue({ ok: true });
  mockApi.markUnread.mockResolvedValue({ ok: true });
  mockApi.deleteMessage.mockResolvedValue({ ok: true, movedCount: 1, trashFolder: "Trash" });
  mockApi.moveMessage.mockResolvedValue({ ok: true, movedCount: 1 });
  mockApi.sendReply.mockResolvedValue({ ok: true, messageId: "<r1>" });
  mockApi.sendNew.mockResolvedValue({ ok: true, messageId: "<f1>" });
  mockApi.getAttachment.mockResolvedValue({
    name: "numbers.pdf",
    mime: "application/pdf",
    size: 5,
    contentBase64: "aGVsbG8=",
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

describe("useEmailMessageActions", () => {
  it("hides the row before the request and reports settle on success", async () => {
    const onOptimistic = vi.fn();
    const onSettled = vi.fn();
    const actions = mountActions({ onOptimistic, onSettled });

    await act(async () => {
      actions.current!.markRead.mutate(header());
    });
    await settle();

    expect(onOptimistic).toHaveBeenCalledWith(42, "read");
    expect(mockApi.markRead).toHaveBeenCalledWith("personal", 42, "INBOX");
    expect(onSettled).toHaveBeenCalled();
  });

  it("puts the row back when the request fails", async () => {
    mockApi.markRead.mockRejectedValue(new Error("imap down"));
    const onRevert = vi.fn();
    const actions = mountActions({ onRevert });

    await act(async () => {
      actions.current!.markRead.mutate(header());
    });
    await settle();

    expect(onRevert).toHaveBeenCalledWith(42);
  });

  it("marks a replied message read so it leaves the unread view", async () => {
    const actions = mountActions();

    await act(async () => {
      actions.current!.reply.mutate({ msg: header(), body: "Thanks", replyAll: true });
    });
    await settle();

    expect(mockApi.sendReply).toHaveBeenCalledWith("personal", 42, "INBOX", "Thanks", {
      replyAll: true,
    });
    expect(mockApi.markRead).toHaveBeenCalledWith("personal", 42, "INBOX");
  });

  it("still counts a reply as sent when the follow-up mark-read fails", async () => {
    mockApi.markRead.mockRejectedValue(new Error("imap down"));
    const actions = mountActions();

    await act(async () => {
      actions.current!.reply.mutate({ msg: header(), body: "Thanks", replyAll: false });
    });
    await settle();

    // The send already happened and cannot be undone, so the mutation must not
    // report failure just because the flag update afterwards did not stick.
    expect(actions.current!.reply.isError).toBe(false);
  });

  it("quotes the original when forwarding and does not double the Fwd prefix", async () => {
    const actions = mountActions();

    await act(async () => {
      actions.current!.forward.mutate({
        msg: parsed({ subject: "Fwd: Quarterly numbers" }),
        to: "colleague@example.com",
        note: "See below",
      });
    });
    await settle();

    const [mailbox, to, subject, body] = mockApi.sendNew.mock.calls[0];
    expect(mailbox).toBe("personal");
    expect(to).toBe("colleague@example.com");
    expect(subject).toBe("Fwd: Quarterly numbers");
    expect(body).toContain("See below");
    expect(body).toContain("---------- Forwarded message ----------");
    expect(body).toContain("From: sender@example.com");
    expect(body).toContain("The numbers are attached.");
  });

  it("adds the Fwd prefix when the subject does not have one", async () => {
    const actions = mountActions();

    await act(async () => {
      actions.current!.forward.mutate({ msg: parsed(), to: "c@example.com", note: "" });
    });
    await settle();

    expect(mockApi.sendNew.mock.calls[0][2]).toBe("Fwd: Quarterly numbers");
    // No attachments on the original means none are fetched or sent.
    expect(mockApi.getAttachment).not.toHaveBeenCalled();
    expect(mockApi.sendNew.mock.calls[0][4]).toBeUndefined();
  });

  it("carries the original attachments along on a forward, skipping inline parts", async () => {
    const onToast = vi.fn();
    const actions = mountActions({ onToast });
    const msg = parsed({
      attachments: [
        { name: "numbers.pdf", mime: "application/pdf", size: 5, partId: "att-0" },
        { name: "logo.png", mime: "image/png", size: 3, partId: "att-1", inline: true },
      ],
    });

    await act(async () => {
      actions.current!.forward.mutate({ msg, to: "c@example.com", note: "" });
    });
    await settle();

    expect(mockApi.getAttachment).toHaveBeenCalledTimes(1);
    expect(mockApi.getAttachment).toHaveBeenCalledWith("personal", "INBOX", 42, "att-0");
    expect(mockApi.sendNew.mock.calls[0][4]).toEqual({
      attachments: [
        { name: "numbers.pdf", mime: "application/pdf", contentBase64: "aGVsbG8=" },
      ],
    });
    expect(onToast).toHaveBeenCalledWith("Forwarded with 1 attachment");
  });

  it("fails the forward instead of sending without a file it could not fetch", async () => {
    mockApi.getAttachment.mockRejectedValue(new Error("imap down"));
    const onToast = vi.fn();
    const actions = mountActions({ onToast });
    const msg = parsed({
      attachments: [{ name: "numbers.pdf", mime: "application/pdf", size: 5, partId: "att-0" }],
    });

    await act(async () => {
      actions.current!.forward.mutate({ msg, to: "c@example.com", note: "" });
    });
    await settle();

    expect(mockApi.sendNew).not.toHaveBeenCalled();
    expect(actions.current!.forward.isError).toBe(true);
    expect(onToast).toHaveBeenCalledWith('Could not fetch attachment "numbers.pdf": imap down');
  });

  it("creates an issue, wakes the agent and marks read when handing off", async () => {
    mockIssuesApi.create.mockResolvedValue({ id: "issue-1" });
    mockAgentsApi.wakeup.mockResolvedValue({});
    const onToast = vi.fn();
    const actions = mountActions({ onToast });

    await act(async () => {
      actions.current!.handOff.mutate({ msg: parsed(), agentId: "agent-1", note: "urgent" });
    });
    await settle();

    const created = mockIssuesApi.create.mock.calls[0][1];
    expect(created.assigneeAgentId).toBe("agent-1");
    expect(created.title).toContain("sender@example.com");
    expect(created.description).toContain("## Operator note");
    expect(created.description).toContain("urgent");
    expect(mockAgentsApi.wakeup).toHaveBeenCalled();
    expect(mockApi.markRead).toHaveBeenCalledWith("personal", 42, "INBOX");
    expect(onToast).toHaveBeenCalledWith("Handed off, issue created", "issue-1");
  });

  it("keeps the hand-off when the agent cannot be woken", async () => {
    mockIssuesApi.create.mockResolvedValue({ id: "issue-2" });
    mockAgentsApi.wakeup.mockRejectedValue(new Error("agent offline"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const actions = mountActions();

    await act(async () => {
      actions.current!.handOff.mutate({ msg: parsed(), agentId: "agent-1", note: "" });
    });
    await settle();

    // The issue exists and is assigned; failing here would tell the operator
    // nothing happened when in fact the work was filed.
    expect(actions.current!.handOff.isError).toBe(false);
    expect(actions.current!.handOff.data?.issueId).toBe("issue-2");
  });

  it("omits the operator note block when no note was written", async () => {
    mockIssuesApi.create.mockResolvedValue({ id: "issue-3" });
    mockAgentsApi.wakeup.mockResolvedValue({});
    const actions = mountActions();

    await act(async () => {
      actions.current!.handOff.mutate({ msg: parsed(), agentId: "agent-1", note: "   " });
    });
    await settle();

    expect(mockIssuesApi.create.mock.calls[0][1].description).not.toContain("## Operator note");
  });

  it("moves a message to the folder the operator picked", async () => {
    const onOptimistic = vi.fn();
    const actions = mountActions({ onOptimistic });

    await act(async () => {
      actions.current!.moveToFolder.mutate({ msg: header(), targetFolder: "Archive" });
    });
    await settle();

    expect(onOptimistic).toHaveBeenCalledWith(42, "gone");
    expect(mockApi.moveMessage).toHaveBeenCalledWith("personal", 42, "INBOX", "Archive");
  });
});
