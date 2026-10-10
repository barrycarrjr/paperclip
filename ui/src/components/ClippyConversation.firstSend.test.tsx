// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { ChatMessage, ChatSession } from "../api/chat";
import { clippyStreamManager } from "../lib/clippy-stream-manager";
import { ClippyConversation } from "./ClippyConversation";

/**
 * A new chat is created by its first send, not when Clippy opens or "New
 * chat" is pressed. These use the real composer and the real hook, so they
 * check the whole way from typing to the message going out.
 */

const mockChatApi = vi.hoisted(() => ({
  listModels: vi.fn(),
  getSession: vi.fn(),
  listMessages: vi.fn(),
  createSession: vi.fn(),
  patchSession: vi.fn(),
  uploadAttachment: vi.fn(),
  decidePermission: vi.fn(),
}));

vi.mock("../api/chat", async () => {
  const actual = await vi.importActual<typeof import("../api/chat")>("../api/chat");
  return { ...actual, chatApi: mockChatApi };
});

vi.mock("../context/CompanyContext", () => ({
  useCompanyOptional: () => ({
    companies: [{ id: "c1", name: "HQ", issuePrefix: "HQ", brandColor: null }],
    selectedCompanyId: "c1",
  }),
}));

vi.mock("@/lib/router", () => ({
  useParams: () => ({ companyPrefix: "HQ" }),
}));

// The real picker opens a second popover; a plain button that picks one
// model is enough to check the choice is kept.
vi.mock("./ModelPicker", () => ({
  ModelPicker: ({ onChange }: { onChange: (id: string) => void }) => (
    <button type="button" aria-label="Pick Claude Opus 5" onClick={() => onChange("claude-opus-5")}>
      Pick model
    </button>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const PAGE = { label: "HQ | Issues", value: "/HQ/issues (company HQ, page Issues)" };
const SUGGESTIONS = ["Which issues are blocked?", "Summarize open issues in HQ", "What changed in the last day?"];

function createdChat(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "new-chat",
    boardUserId: "user-1",
    companyId: "c1",
    title: "New chat",
    model: "claude-sonnet-5-5",
    mode: "agent",
    permissionMode: "ask",
    effort: "auto",
    pageContext: PAGE.value,
    archivedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let startTurn: MockInstance<typeof clippyStreamManager.startTurn>;
/** Ends the turn the last startTurn began. Until then the reply is still coming. */
let finishTurn: () => void;

async function flush() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderConversation(sessionId: string | null, onSessionCreated: (session: ChatSession) => void) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ClippyConversation
          sessionId={sessionId}
          showHeader={false}
          newChatCompanyId="c1"
          onSessionCreated={onSessionCreated}
          pageContext={PAGE}
          greetingName="Pat"
          suggestions={SUGGESTIONS}
        />
      </QueryClientProvider>,
    );
  });
  await flush();
}

async function renderNewChat(onSessionCreated = vi.fn()) {
  await renderConversation(null, onSessionCreated);
  return { onSessionCreated };
}

async function attach(file: File) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  await act(async () => {
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

function textarea(): HTMLTextAreaElement {
  const el = container.querySelector("textarea");
  if (!el) throw new Error("composer textarea not found");
  return el;
}

async function type(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea(), text);
    textarea().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pressEnter() {
  await act(async () => {
    textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await flush();
}

function byLabel(label: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  expect(found, `nothing labelled "${label}"`).not.toBeNull();
  return found!;
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

function radio(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
    (candidate) => candidate.textContent === label,
  );
  expect(found, `no "${label}" choice`).toBeDefined();
  return found!;
}

describe("a new Clippy chat", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    for (const fn of Object.values(mockChatApi)) fn.mockReset();
    mockChatApi.listModels.mockResolvedValue({ models: [] });
    mockChatApi.createSession.mockResolvedValue({ session: createdChat() });
    mockChatApi.listMessages.mockResolvedValue({ messages: [] });
    mockChatApi.getSession.mockImplementation((id: string) => Promise.resolve({ session: createdChat({ id }) }));
    // A turn whose reply has not finished: the real case while a first
    // message is answered. A turn that ended at once hid the bug where the
    // chat only opened after the reply.
    startTurn = vi.spyOn(clippyStreamManager, "startTurn").mockImplementation(() => {
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      finishTurn = resolveDone;
      return { abort: vi.fn(), done };
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    startTurn.mockRestore();
  });

  it("creates nothing until its first message is sent", async () => {
    await renderNewChat();

    expect(container.textContent).toContain("How can I help, Pat?");
    for (const suggestion of SUGGESTIONS) expect(container.textContent).toContain(suggestion);
    expect(container.textContent).toContain("Context:");
    expect(container.textContent).toContain("HQ | Issues");
    expect(mockChatApi.createSession).not.toHaveBeenCalled();
  });

  it("creates the chat on the first send, with the page it was opened on, and sends that message to it", async () => {
    const { onSessionCreated } = await renderNewChat();

    await type("Remind me to send the IRS letter");
    await pressEnter();

    expect(mockChatApi.createSession).toHaveBeenCalledTimes(1);
    expect(mockChatApi.createSession).toHaveBeenCalledWith({
      companyId: "c1",
      permissionMode: "ask",
      pageContext: PAGE.value,
    });
    expect(startTurn).toHaveBeenCalledWith("new-chat", "Remind me to send the IRS letter", []);
    expect(onSessionCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "new-chat" }));
    // The message is on screen for the new chat before any reply arrives.
    const shown = queryClient.getQueryData<ChatMessage[]>(["clippy", "messages", "new-chat"]);
    expect(shown?.map((m) => m.content)).toEqual([[{ type: "text", text: "Remind me to send the IRS letter" }]]);
    await act(async () => finishTurn());
  });

  it("opens the new chat as soon as its reply starts, not once the reply has finished", async () => {
    // It used to wait for the whole reply: the window showed an empty new
    // chat meanwhile, and a permission prompt in that reply was never seen.
    const { onSessionCreated } = await renderNewChat();

    await type("Remind me to send the IRS letter");
    await pressEnter();

    expect(startTurn).toHaveBeenCalledTimes(1);
    expect(onSessionCreated).toHaveBeenCalledTimes(1);
    await act(async () => finishTurn());
    await flush();
    expect(onSessionCreated).toHaveBeenCalledTimes(1);
  });

  it("does not pull the person back to the new chat once they have moved to another one", async () => {
    let createChat!: (value: { session: ChatSession }) => void;
    mockChatApi.createSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          createChat = resolve;
        }),
    );
    const onSessionCreated = vi.fn();
    await renderNewChat(onSessionCreated);

    await type("Remind me to send the IRS letter");
    await pressEnter();
    // While the chat is still being made, the person opens another one.
    await renderConversation("other-chat", onSessionCreated);
    await act(async () => createChat({ session: createdChat() }));
    await flush();

    // The message still goes to the new chat, in the background.
    expect(startTurn).toHaveBeenCalledWith("new-chat", "Remind me to send the IRS letter", []);
    expect(onSessionCreated).not.toHaveBeenCalled();
    await act(async () => finishTurn());
  });

  it("keeps the model, permissions and effort chosen before the first send", async () => {
    mockChatApi.createSession.mockResolvedValue({
      session: createdChat({ model: "claude-opus-5", permissionMode: "bypass" }),
    });
    mockChatApi.patchSession.mockResolvedValue({
      session: createdChat({ model: "claude-opus-5", permissionMode: "bypass", effort: "high" }),
    });
    await renderNewChat();

    await click(byLabel("Chat options: Default model, Ask permission, effort Auto"));
    await click(byLabel("Pick Claude Opus 5"));
    await click(radio("Bypass permissions"));
    await click(radio("High"));
    expect(mockChatApi.createSession).not.toHaveBeenCalled();

    await type("Summarize open issues in HQ");
    await pressEnter();

    expect(mockChatApi.createSession).toHaveBeenCalledWith({
      companyId: "c1",
      model: "claude-opus-5",
      permissionMode: "bypass",
      pageContext: PAGE.value,
    });
    expect(mockChatApi.patchSession).toHaveBeenCalledWith("new-chat", { effort: "high" });
    // The effort is set before the message goes, so the first turn uses it.
    expect(mockChatApi.patchSession.mock.invocationCallOrder[0]).toBeLessThan(startTurn.mock.invocationCallOrder[0]!);
    expect(startTurn).toHaveBeenCalledWith("new-chat", "Summarize open issues in HQ", []);
  });

  it("holds files picked before the first send, then uploads them to the new chat and sends them with it", async () => {
    mockChatApi.uploadAttachment.mockResolvedValue({
      id: "att-1",
      sessionId: "new-chat",
      kind: "file",
      mediaType: "application/pdf",
      name: "irs-letter.pdf",
      sizeBytes: 12,
      url: "/x",
    });
    await renderNewChat();

    const file = new File(["%PDF-1.4 hello"], "irs-letter.pdf", { type: "application/pdf" });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    await act(async () => {
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(container.textContent).toContain("irs-letter.pdf");
    // Nowhere to upload to yet, and nothing created just for a file.
    expect(mockChatApi.uploadAttachment).not.toHaveBeenCalled();
    expect(mockChatApi.createSession).not.toHaveBeenCalled();

    await type("Here is the letter");
    await pressEnter();

    expect(mockChatApi.uploadAttachment).toHaveBeenCalledWith("new-chat", file);
    expect(startTurn).toHaveBeenCalledWith("new-chat", "Here is the letter", ["att-1"]);
  });

  it("creates the chat without the page once its context chip is removed", async () => {
    await renderNewChat();

    await click(byLabel("Remove page context: HQ | Issues"));
    expect(container.textContent).not.toContain("Context:");

    await type("What needs my attention today?");
    await pressEnter();

    expect(mockChatApi.createSession).toHaveBeenCalledWith(expect.objectContaining({ pageContext: null }));
  });

  it("sends a suggested question as the first message", async () => {
    await renderNewChat();

    const suggestion = [...container.querySelectorAll("button")].find((b) => b.textContent === SUGGESTIONS[0]);
    await click(suggestion!);

    expect(mockChatApi.createSession).toHaveBeenCalledTimes(1);
    expect(startTurn).toHaveBeenCalledWith("new-chat", "Which issues are blocked?", []);
  });

  it("keeps the chat it made when setting the effort fails, so sending again does not make a second one", async () => {
    mockChatApi.patchSession
      .mockRejectedValueOnce(new Error("Could not save the effort"))
      .mockResolvedValueOnce({ session: createdChat({ effort: "high" }) });
    await renderNewChat();

    await click(byLabel("Chat options: Default model, Ask permission, effort Auto"));
    await click(radio("High"));
    await type("Summarize open issues in HQ");
    await pressEnter();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not save the effort");
    expect(textarea().value).toBe("Summarize open issues in HQ");
    expect(startTurn).not.toHaveBeenCalled();

    await pressEnter();

    expect(mockChatApi.createSession).toHaveBeenCalledTimes(1);
    expect(mockChatApi.patchSession).toHaveBeenCalledTimes(2);
    expect(startTurn).toHaveBeenCalledWith("new-chat", "Summarize open issues in HQ", []);
    await act(async () => finishTurn());
  });

  it("tries a failed upload again when the message is sent again, rather than sending without it", async () => {
    mockChatApi.uploadAttachment
      .mockRejectedValueOnce(new Error("Upload failed: 502"))
      .mockResolvedValueOnce({
        id: "att-1",
        sessionId: "new-chat",
        kind: "file",
        mediaType: "application/pdf",
        name: "irs-letter.pdf",
        sizeBytes: 12,
        url: "/x",
      });
    await renderNewChat();
    const file = new File(["%PDF-1.4 hello"], "irs-letter.pdf", { type: "application/pdf" });
    await attach(file);

    await type("Here is the letter");
    await pressEnter();

    // Nothing went, and the file and its chip are still there.
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("nothing was sent");
    expect(container.textContent).toContain("irs-letter.pdf");
    expect(textarea().value).toBe("Here is the letter");
    expect(startTurn).not.toHaveBeenCalled();

    await pressEnter();

    expect(mockChatApi.createSession).toHaveBeenCalledTimes(1);
    expect(mockChatApi.uploadAttachment).toHaveBeenCalledTimes(2);
    expect(mockChatApi.uploadAttachment).toHaveBeenLastCalledWith("new-chat", file);
    expect(startTurn).toHaveBeenCalledWith("new-chat", "Here is the letter", ["att-1"]);
    await act(async () => finishTurn());
  });

  it("keeps the message when the chat cannot be created, and says so", async () => {
    mockChatApi.createSession.mockRejectedValue(new Error("Chat is available to board users only"));
    const { onSessionCreated } = await renderNewChat();

    await type("Remind me to send the IRS letter");
    await pressEnter();

    expect(textarea().value).toBe("Remind me to send the IRS letter");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("board users only");
    expect(startTurn).not.toHaveBeenCalled();
    expect(onSessionCreated).not.toHaveBeenCalled();
  });
});
