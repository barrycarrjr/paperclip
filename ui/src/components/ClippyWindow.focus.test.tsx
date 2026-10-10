// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ClippyProvider } from "../context/ClippyContext";
import { ClippyLauncher } from "./ClippyLauncher";
import { ClippyWindow } from "./ClippyWindow";

/**
 * Closing Clippy used to drop focus on the page body, so the next Tab press
 * started again at the very top of the document. On a phone that means
 * walking the whole sidebar before reaching anything on the page.
 *
 * The real launcher and window are used here, not stand ins, because the fix
 * lives in how they hand focus to each other.
 */

const companyState = vi.hoisted(() => ({
  companies: [
    { id: "company-1", name: "Paperclip", issuePrefix: "PAP", isPortfolioRoot: false, brandColor: null },
  ] as Array<Record<string, unknown>>,
  selectedCompanyId: "company-1" as string | null,
}));

const mockChatApi = vi.hoisted(() => ({
  listSessions: vi.fn(),
  getSession: vi.fn(),
  createSession: vi.fn(),
  patchSession: vi.fn(),
  deleteSession: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
  useCompanyOptional: () => companyState,
}));

vi.mock("@/lib/router", () => ({
  useParams: () => ({ companyPrefix: "PAP" }),
  useLocation: () => ({ pathname: "/PAP/dashboard", search: "", hash: "", state: null }),
}));

vi.mock("../api/chat", () => ({ chatApi: mockChatApi }));

vi.mock("./ClippyConversation", () => ({
  ClippyConversation: () => <div data-testid="conversation" />,
}));

vi.mock("../hooks/useClippyPage", () => ({
  useClippyPage: () => ({ pageContext: null, suggestions: [] }),
  useClippyGreetingName: () => null,
}));

vi.mock("../lib/clippy-stream-manager", () => ({
  clippyStreamManager: {
    subscribe: () => () => {},
    getSnapshot: () => ({ streaming: false }),
    subscribeGlobal: () => () => {},
    getPendingActionCount: () => 0,
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function launcher(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>('button[aria-label^="Ask Clippy"]');
  expect(button, "no Clippy launcher on the page").not.toBeNull();
  return button!;
}

function clippyWindow(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-clippy-mode]");
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("closing Clippy", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    window.localStorage.clear();
    mockChatApi.listSessions.mockReset();
    mockChatApi.listSessions.mockResolvedValue({
      sessions: [{ id: "session-pap", companyId: "company-1", title: "Paperclip chat", model: "opus", updatedAt: new Date().toISOString() }],
    });
    mockChatApi.getSession.mockResolvedValue({
      session: { id: "session-pap", companyId: "company-1", title: "Paperclip chat", model: "opus" },
    });
    root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <ClippyProvider>
              <ClippyLauncher />
              <ClippyWindow />
            </ClippyProvider>
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("moves focus into Clippy when it opens, and back to the launcher on Escape", async () => {
    const openButton = launcher();
    openButton.focus();

    await act(async () => {
      openButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const opened = clippyWindow();
    expect(opened).not.toBeNull();
    expect(opened!.contains(document.activeElement)).toBe(true);
    // The launcher steps aside while the window is open.
    expect(openButton.hidden).toBe(true);

    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();

    expect(clippyWindow()).toBeNull();
    expect(launcher().hidden).toBe(false);
    expect(document.activeElement).toBe(launcher());
  });

  it("puts focus back on the chats button when the menu closes, without popping a tooltip over the window", async () => {
    await act(async () => {
      launcher().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const menuButton = document.querySelector<HTMLButtonElement>('button[aria-label="Show chats"]')!;
    await act(async () => {
      menuButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const menu = document.querySelector<HTMLElement>('[role="region"][aria-label="Chats"]')!;
    expect(menu).not.toBeNull();

    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();

    expect(document.querySelector('[role="region"][aria-label="Chats"]')).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Show chats");
    // A Tooltip opened on that focus and then sat over the window.
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("puts focus back on the launcher when the close button is used", async () => {
    await act(async () => {
      launcher().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const close = document.querySelector<HTMLButtonElement>('button[aria-label="Close Clippy"]');
    expect(close).not.toBeNull();
    close!.focus();

    await act(async () => {
      close!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();

    expect(clippyWindow()).toBeNull();
    expect(document.activeElement).toBe(launcher());
  });
});
