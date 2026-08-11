// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { MailHeader } from "../../api/emailTools";
import { EmailPopoutDialog, type EmailPopoutRequest } from "./EmailPopoutDialog";

const mockApi = vi.hoisted(() => ({
  fetchMessage: vi.fn(),
  listFolders: vi.fn(),
  markRead: vi.fn(),
  markUnread: vi.fn(),
  deleteMessage: vi.fn(),
  moveMessage: vi.fn(),
  sendReply: vi.fn(),
  sendNew: vi.fn(),
}));

vi.mock("../../api/emailTools", () => ({ makeEmailToolsApi: () => mockApi }));
vi.mock("../../api/issues", () => ({ issuesApi: { create: vi.fn() } }));
vi.mock("../../api/agents", () => ({ agentsApi: { list: vi.fn(async () => []), wakeup: vi.fn() } }));
vi.mock("../../hooks/usePrintToolsPlugin", () => ({
  usePrintToolsPlugin: () => ({ pluginId: null, availability: "missing", isLoading: false }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

function request(overrides: Partial<EmailPopoutRequest> = {}): EmailPopoutRequest {
  return {
    pluginId: "p1",
    companyId: "c1",
    mailbox: "personal",
    folder: "INBOX",
    uid: 42,
    header: header(),
    ...overrides,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mountDialog(req: EmailPopoutRequest, onClose = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        {/* main.tsx wraps the whole app in one; the dialog inherits it. */}
        <TooltipProvider>
          <EmailPopoutDialog request={req} onClose={onClose} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
  return { onClose };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

function readToggle(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Mark as read"], button[aria-label="Mark as unread"]',
  );
  if (!button) throw new Error("read/unread toggle not rendered");
  return button;
}

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
  mockApi.fetchMessage.mockResolvedValue({
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
  });
  mockApi.listFolders.mockResolvedValue({ folders: ["Archive"] });
  mockApi.markRead.mockResolvedValue({ ok: true });
  mockApi.markUnread.mockResolvedValue({ ok: true });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  document.body.innerHTML = "";
});

describe("EmailPopoutDialog read/unread toggle", () => {
  it("offers to mark an unread message read", async () => {
    await mountDialog(request());

    expect(readToggle().getAttribute("aria-label")).toBe("Mark as read");
  });

  it("offers to mark a read message unread", async () => {
    await mountDialog(request({ header: header({ unseen: false }) }));

    expect(readToggle().getAttribute("aria-label")).toBe("Mark as unread");
  });

  it("marks read and flips to the other direction without closing", async () => {
    const { onClose } = await mountDialog(request());

    await act(async () => {
      readToggle().click();
    });
    await settle();

    expect(mockApi.markRead).toHaveBeenCalledWith("personal", 42, "INBOX");
    expect(readToggle().getAttribute("aria-label")).toBe("Mark as unread");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("marks unread again on the second click", async () => {
    await mountDialog(request());

    await act(async () => {
      readToggle().click();
    });
    await settle();
    await act(async () => {
      readToggle().click();
    });
    await settle();

    expect(mockApi.markUnread).toHaveBeenCalledWith("personal", 42, "INBOX");
    expect(readToggle().getAttribute("aria-label")).toBe("Mark as read");
  });

  it("puts the button back the way it was when the request fails", async () => {
    mockApi.markRead.mockRejectedValue(new Error("imap down"));
    await mountDialog(request());

    await act(async () => {
      readToggle().click();
    });
    await settle();

    expect(readToggle().getAttribute("aria-label")).toBe("Mark as read");
  });
});
