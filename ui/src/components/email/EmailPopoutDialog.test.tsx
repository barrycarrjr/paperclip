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
  getAttachment: vi.fn(),
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

async function mountDialog(
  req: EmailPopoutRequest,
  onClose = vi.fn(),
  actionHooks?: React.ComponentProps<typeof EmailPopoutDialog>["actionHooks"],
) {
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
          <EmailPopoutDialog request={req} onClose={onClose} actionHooks={actionHooks} />
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

/** Click a toolbar button by the label its tooltip announces. */
async function clickToolbar(label: string) {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`toolbar button "${label}" not rendered`);
  await act(async () => {
    button.click();
  });
  await settle();
}

/** Click the button whose visible text is `text`. */
async function clickByText(text: string) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
  );
  if (!button) throw new Error(`button "${text}" not rendered`);
  await act(async () => {
    button.click();
  });
  await settle();
}

/** Type into a text input the way React's onChange expects. */
async function typeInto(selector: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`input "${selector}" not rendered`);
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

describe("EmailPopoutDialog failure reporting", () => {
  // The bug: the operator filled in a forward, clicked send, the server
  // rejected it, and the dialog showed nothing at all. The composer stayed
  // open with the recipient still in it, which is what a dead button looks
  // like, so the message was assumed sent when it never left.
  it("shows why a forward was rejected instead of looking like nothing happened", async () => {
    mockApi.sendNew.mockRejectedValue(new Error("Sending is disabled."));
    await mountDialog(request());

    await clickToolbar("Forward");
    await typeInto('input[placeholder="to@example.com"]', "accounting@example.com");
    await clickByText("Send forward");

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("Sending is disabled.");
    // Still there to retry: a rejected send must not lose what was typed.
    expect(
      document.querySelector<HTMLInputElement>('input[placeholder="to@example.com"]')?.value,
    ).toBe("accounting@example.com");
  });

  it("says something even when the rejection carried no message", async () => {
    mockApi.sendNew.mockRejectedValue(new Error(""));
    await mountDialog(request());

    await clickToolbar("Forward");
    await typeInto('input[placeholder="to@example.com"]', "accounting@example.com");
    await clickByText("Send forward");

    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "That did not go through. Try again.",
    );
  });

  it("clears the notice when the composer is reopened for a fresh attempt", async () => {
    mockApi.sendNew.mockRejectedValue(new Error("Sending is disabled."));
    await mountDialog(request());

    await clickToolbar("Forward");
    await typeInto('input[placeholder="to@example.com"]', "accounting@example.com");
    await clickByText("Send forward");
    expect(document.querySelector('[role="alert"]')).not.toBeNull();

    await clickToolbar("Forward"); // close
    await clickToolbar("Forward"); // and open again

    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("closes the composer and keeps quiet when the forward goes out", async () => {
    mockApi.sendNew.mockResolvedValue({ ok: true, messageId: "<f1>" });
    const onToast = vi.fn();
    await mountDialog(request(), vi.fn(), { onToast });

    await clickToolbar("Forward");
    await typeInto('input[placeholder="to@example.com"]', "accounting@example.com");
    await clickByText("Send forward");

    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelector('input[placeholder="to@example.com"]')).toBeNull();
    expect(onToast).toHaveBeenCalledWith("Forwarded");
  });

  it("shows why a reply was rejected", async () => {
    mockApi.sendReply.mockRejectedValue(new Error("smtp refused"));
    await mountDialog(request());

    await clickToolbar("Reply");
    const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("reply box not rendered");
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setter.call(textarea, "Thanks");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    await clickByText("Send reply");

    expect(document.querySelector('[role="alert"]')?.textContent).toBe("smtp refused");
  });
});
