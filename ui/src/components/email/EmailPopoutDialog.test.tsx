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
  listMailboxes: vi.fn(),
  markRead: vi.fn(),
  markUnread: vi.fn(),
  deleteMessage: vi.fn(),
  moveMessage: vi.fn(),
  sendReply: vi.fn(),
  sendNew: vi.fn(),
  getAttachment: vi.fn(),
}));
const mockDraftsApi = vi.hoisted(() => ({ draftReply: vi.fn() }));

vi.mock("../../api/emailTools", () => ({ makeEmailToolsApi: () => mockApi }));
vi.mock("../../api/emailDrafts", () => ({ emailDraftsApi: mockDraftsApi }));
const mockChatApi = vi.hoisted(() => ({ listModels: vi.fn() }));
vi.mock("../../api/chat", () => ({ chatApi: mockChatApi }));
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
let queryClient: QueryClient | null = null;

async function renderDialog(
  req: EmailPopoutRequest,
  onClose: () => void,
  actionHooks?: React.ComponentProps<typeof EmailPopoutDialog>["actionHooks"],
) {
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient!}>
        {/* main.tsx wraps the whole app in one; the dialog inherits it. */}
        <TooltipProvider>
          <EmailPopoutDialog request={req} onClose={onClose} actionHooks={actionHooks} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
}

async function mountDialog(
  req: EmailPopoutRequest,
  onClose = vi.fn(),
  actionHooks?: React.ComponentProps<typeof EmailPopoutDialog>["actionHooks"],
) {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await renderDialog(req, onClose, actionHooks);
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
  mockDraftsApi.draftReply.mockReset();
  mockChatApi.listModels.mockReset();
  mockChatApi.listModels.mockResolvedValue({ models: [] });
  localStorage.removeItem("email-draftModel");
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
  mockApi.listMailboxes.mockResolvedValue({
    mailboxes: [{ key: "personal", name: "Personal", pollFolder: "INBOX", from: "me@example.com" }],
  });
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
  queryClient = null;
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

describe("EmailPopoutDialog replied and forwarded marks", () => {
  // The pop-out is how Portfolio Email opens a message, so this is where the
  // operator looks for the replied icon Outlook would show.
  it("says a message was replied to and forwarded when the mailbox says so", async () => {
    mockApi.fetchMessage.mockResolvedValue({
      ...(await mockApi.fetchMessage()),
      answered: true,
      forwarded: true,
    });
    await mountDialog(request());

    expect(document.querySelector('[title="Replied"]')?.textContent).toBe("Replied");
    expect(document.querySelector('[title="Forwarded"]')?.textContent).toBe("Forwarded");
  });

  it("shows no mark on a message nobody has answered", async () => {
    await mountDialog(request());

    expect(document.querySelector('[title="Replied"]')).toBeNull();
    expect(document.querySelector('[title="Forwarded"]')).toBeNull();
  });

  it("picks up the replied mark on the message still open after replying from it", async () => {
    // The dialog stays open after a reply, so the message it shows has to be
    // fetched again or it goes on looking unanswered.
    const unmarked = await mockApi.fetchMessage();
    mockApi.fetchMessage.mockResolvedValue({ ...unmarked, answered: true });
    mockApi.fetchMessage.mockResolvedValueOnce(unmarked);
    mockApi.sendReply.mockResolvedValue({ ok: true, messageId: "<r1>" });
    await mountDialog(request());
    expect(document.querySelector('[title="Replied"]')).toBeNull();

    await clickToolbar("Reply");
    await typeReply("Thanks");
    await clickByText("Send reply");
    await settle();
    await settle();

    expect(document.querySelector('[title="Replied"]')?.textContent).toBe("Replied");
  });

  it("picks up the forwarded mark on the message still open after forwarding it", async () => {
    const unmarked = await mockApi.fetchMessage();
    mockApi.fetchMessage.mockResolvedValue({ ...unmarked, forwarded: true });
    mockApi.fetchMessage.mockResolvedValueOnce(unmarked);
    mockApi.sendNew.mockResolvedValue({ ok: true, messageId: "<f1>" });
    await mountDialog(request());
    expect(document.querySelector('[title="Forwarded"]')).toBeNull();

    await clickToolbar("Forward");
    await typeInto('input[placeholder="to@example.com"]', "accounting@example.com");
    await clickByText("Send forward");
    await settle();
    await settle();

    expect(document.querySelector('[title="Forwarded"]')?.textContent).toBe("Forwarded");
    // The forward named the message it forwarded, so the mailbox could mark it.
    expect(mockApi.sendNew.mock.calls[0][4]).toEqual({
      forwardOf: { uid: 42, folder: "INBOX", messageId: "<m1>" },
    });
  });
});

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

const INSTRUCTIONS = 'input[aria-label="Instructions for the AI draft"]';

function replyBox(): HTMLTextAreaElement {
  const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
  if (!textarea) throw new Error("reply box not rendered");
  return textarea;
}

/** Type into the reply box the way React's onChange expects. */
async function typeReply(value: string) {
  const textarea = replyBox();
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

function buttonText(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
  );
}

function secondMessage() {
  return {
    uid: 43,
    messageId: "<m2>",
    inReplyTo: null,
    references: [],
    from: "other@example.com",
    fromAddress: "other@example.com",
    to: ["me@example.com"],
    cc: [],
    subject: "Something else",
    date: "2026-08-02T10:00:00.000Z",
    text: "A different question.",
    html: "",
    markdown: "A different question.",
    attachments: [],
  };
}

describe("EmailPopoutDialog AI draft", () => {
  // The bug: the Email page's reply box had the AI helper and the pop-out's
  // did not, so replying from the portfolio list meant writing by hand.
  it("offers the AI helper in the reply box", async () => {
    await mountDialog(request());

    await clickToolbar("Reply");

    expect(document.querySelector(INSTRUCTIONS)).not.toBeNull();
    expect(document.querySelector('[title="Model used for AI Draft"]')).not.toBeNull();
    expect(buttonText("AI Draft")).toBeDefined();
  });

  it("writes the reply from the message and the operator's instructions", async () => {
    mockDraftsApi.draftReply.mockResolvedValue({ draft: "Happy to send them over.", model: "m1" });
    await mountDialog(request());

    await clickToolbar("Reply");
    await typeInto(INSTRUCTIONS, "offer to send the Q3 file");
    await clickByText("AI Draft");

    expect(mockDraftsApi.draftReply).toHaveBeenCalledWith({
      from: "sender@example.com",
      subject: "Quarterly numbers",
      bodyText: "The numbers are attached.",
      instructions: "offer to send the Q3 file",
      currentDraft: undefined,
      model: undefined,
    });
    expect(replyBox().value).toBe("Happy to send them over.");
    // Kept, so the next click refines this draft instead of starting over.
    expect(document.querySelector<HTMLInputElement>(INSTRUCTIONS)?.value).toBe(
      "offer to send the Q3 file",
    );
  });

  it("revises what is already in the reply box instead of starting over", async () => {
    mockDraftsApi.draftReply.mockResolvedValue({ draft: "Thanks, sending it today.", model: "m1" });
    await mountDialog(request());

    await clickToolbar("Reply");
    await typeReply("thanks will send");
    await clickByText("AI Revise");

    expect(mockDraftsApi.draftReply.mock.calls[0][0].currentDraft).toBe("thanks will send");
    expect(replyBox().value).toBe("Thanks, sending it today.");
  });

  it("drafts when Enter is pressed in the instructions", async () => {
    mockDraftsApi.draftReply.mockResolvedValue({ draft: "Sure.", model: "m1" });
    await mountDialog(request());

    await clickToolbar("Reply");
    await typeInto(INSTRUCTIONS, "say yes");
    const input = document.querySelector<HTMLInputElement>(INSTRUCTIONS)!;
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settle();

    expect(mockDraftsApi.draftReply).toHaveBeenCalledTimes(1);
    expect(replyBox().value).toBe("Sure.");
  });

  it("drafts with the model the operator picked on the Email page", async () => {
    localStorage.setItem("email-draftModel", "claude-sonnet-5");
    // The pick only counts while the providers still offer it.
    mockChatApi.listModels.mockResolvedValue({ models: [{ provider: "anthropic", model: "claude-sonnet-5" }] });
    mockDraftsApi.draftReply.mockResolvedValue({ draft: "Sure.", model: "claude-sonnet-5" });
    await mountDialog(request());

    await clickToolbar("Reply");
    await clickByText("AI Draft");

    expect(mockDraftsApi.draftReply.mock.calls[0][0].model).toBe("claude-sonnet-5");
  });

  it("lets the server pick when the saved model is no longer offered", async () => {
    localStorage.setItem("email-draftModel", "claude-opus-4-7");
    mockChatApi.listModels.mockResolvedValue({ models: [{ provider: "anthropic", model: "claude-sonnet-5" }] });
    mockDraftsApi.draftReply.mockResolvedValue({ draft: "Sure.", model: "claude-sonnet-5" });
    await mountDialog(request());

    await clickToolbar("Reply");
    await clickByText("AI Draft");

    expect(mockDraftsApi.draftReply.mock.calls[0][0].model).toBeUndefined();
  });

  it("says why a draft failed and leaves the reply alone", async () => {
    mockDraftsApi.draftReply.mockRejectedValue(new Error("No LLM provider is configured."));
    await mountDialog(request());

    await clickToolbar("Reply");
    await typeReply("My own words");
    await clickByText("AI Revise");

    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "AI draft failed: No LLM provider is configured.",
    );
    expect(replyBox().value).toBe("My own words");
  });

  it("drops a draft that comes back after the operator has moved to another message", async () => {
    let finishDraft: (value: { draft: string; model: string }) => void = () => {};
    mockDraftsApi.draftReply.mockReturnValue(
      new Promise((resolve) => {
        finishDraft = resolve;
      }),
    );
    const onClose = vi.fn();
    await mountDialog(request(), onClose);

    await clickToolbar("Reply");
    await clickByText("AI Draft");

    mockApi.fetchMessage.mockResolvedValue(secondMessage());
    await renderDialog(
      request({ uid: 43, header: header({ uid: 43, messageId: "<m2>", from: "other@example.com" }) }),
      onClose,
    );
    await clickToolbar("Reply");
    await act(async () => {
      finishDraft({ draft: "Reply meant for the first sender", model: "m1" });
    });
    await settle();

    expect(replyBox().value).toBe("");
  });

  it("clears the AI instructions when a different message opens", async () => {
    const onClose = vi.fn();
    await mountDialog(request(), onClose);

    await clickToolbar("Reply");
    await typeInto(INSTRUCTIONS, "decline politely");

    mockApi.fetchMessage.mockResolvedValue(secondMessage());
    await renderDialog(
      request({ uid: 43, header: header({ uid: 43, messageId: "<m2>", from: "other@example.com" }) }),
      onClose,
    );
    await clickToolbar("Reply");

    expect(document.querySelector<HTMLInputElement>(INSTRUCTIONS)?.value).toBe("");
  });
});

describe("EmailPopoutDialog reply extras", () => {
  it("shows which address the reply leaves from", async () => {
    await mountDialog(request());

    await clickToolbar("Reply");

    expect(document.querySelector('[data-testid="sending-identity"]')?.textContent).toBe(
      "FromPersonal <me@example.com>",
    );
  });

  it("shows which address a forward leaves from", async () => {
    await mountDialog(request());

    await clickToolbar("Forward");

    expect(document.querySelector('[data-testid="sending-identity"]')?.textContent).toBe(
      "FromPersonal <me@example.com>",
    );
  });

  it("leaves the From line off while the mailbox list is still loading", async () => {
    // "No mailbox selected" in red would be untrue: one is, it just has not loaded.
    mockApi.listMailboxes.mockReturnValue(new Promise(() => {}));
    await mountDialog(request());

    await clickToolbar("Reply");

    expect(document.querySelector('[data-testid="sending-identity"]')).toBeNull();
  });

  it("sends picked files with the reply", async () => {
    mockApi.sendReply.mockResolvedValue({ ok: true, messageId: "<r1>" });
    await mountDialog(request());

    await clickToolbar("Reply");
    await typeReply("Here it is");
    const picker = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!picker) throw new Error("file picker not rendered");
    const file = new File(["hello"], "q3.pdf", { type: "application/pdf" });
    Object.defineProperty(picker, "files", { configurable: true, value: [file] });
    await act(async () => {
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // FileReader finishes on a later tick.
    await settle();
    await settle();
    await clickByText("Send reply");

    expect(mockApi.sendReply).toHaveBeenCalledWith("personal", 42, "INBOX", "Here it is", {
      replyAll: false,
      attachments: [{ name: "q3.pdf", mime: "application/pdf", contentBase64: "aGVsbG8=" }],
    });
  });
});
