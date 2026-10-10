// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClippyProvider, activeSessionStorageKey } from "../context/ClippyContext";
import { ClippyLauncher } from "./ClippyLauncher";
import { ClippyWindow } from "./ClippyWindow";

const PAPERCLIP = { id: "company-1", name: "Paperclip", issuePrefix: "PAP", isPortfolioRoot: false, brandColor: null };
const ACME = { id: "company-2", name: "Acme", issuePrefix: "ACM", isPortfolioRoot: false, brandColor: null };
const EMPTY = { id: "company-3", name: "Empty Co", issuePrefix: "EMP", isPortfolioRoot: false, brandColor: null };

const companyState = vi.hoisted(() => ({
  companies: [] as Array<Record<string, unknown>>,
  selectedCompanyId: "company-1" as string | null,
}));

const routeState = vi.hoisted(() => ({
  companyPrefix: "PAP" as string | undefined,
}));

const mockChatApi = vi.hoisted(() => ({
  listSessions: vi.fn(),
  getSession: vi.fn(),
  createSession: vi.fn(),
  patchSession: vi.fn(),
  deleteSession: vi.fn(),
}));

/** Every sessionId the conversation pane has been asked to show, in order. */
const shownSessionIds = vi.hoisted(() => ({ calls: [] as Array<string | null> }));

/** What the conversation pane calls when a new chat's first send made one. */
const conversationProps = vi.hoisted(() => ({
  onSessionCreated: null as null | ((session: Record<string, unknown>) => void),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
  useCompanyOptional: () => companyState,
}));

// Clippy reads its company out of the web address (useActiveCompanyId).
vi.mock("@/lib/router", () => ({
  useParams: () => ({ companyPrefix: routeState.companyPrefix }),
  useLocation: () => ({ pathname: `/${routeState.companyPrefix}/dashboard`, search: "", hash: "", state: null }),
}));

vi.mock("../api/chat", () => ({ chatApi: mockChatApi }));

vi.mock("./ClippyConversation", () => ({
  ClippyConversation: ({
    sessionId,
    onSessionCreated,
  }: {
    sessionId: string | null;
    onSessionCreated?: (session: Record<string, unknown>) => void;
  }) => {
    shownSessionIds.calls.push(sessionId);
    conversationProps.onSessionCreated = onSessionCreated ?? null;
    return <div data-testid="conversation">{sessionId ?? "new chat"}</div>;
  },
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

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function renderClippy(container: HTMLDivElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const root = createRoot(container);
  // A fresh element every time: React skips the work when handed back the
  // exact same element object, and these tests re-render on purpose.
  const draw = () =>
    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <ClippyProvider>
            <ClippyLauncher />
            <ClippyWindow />
          </ClippyProvider>
        </QueryClientProvider>,
      ),
    );
  draw();
  return { root, rerender: draw };
}

function clickByLabel(container: HTMLDivElement, label: string) {
  const button = Array.from(container.querySelectorAll("button"))
    .find((candidate) => candidate.getAttribute("aria-label")?.startsWith(label));
  expect(button, `no button labelled "${label}"`).not.toBeUndefined();
  return act(async () => {
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function switchCompany(company: { id: string; issuePrefix: string }, rerender: () => void) {
  companyState.selectedCompanyId = company.id;
  routeState.companyPrefix = company.issuePrefix;
  rerender();
}

describe("Clippy across a company change", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    window.localStorage.clear();
    companyState.companies = [PAPERCLIP, ACME, EMPTY];
    companyState.selectedCompanyId = "company-1";
    routeState.companyPrefix = "PAP";
    shownSessionIds.calls = [];
    for (const fn of Object.values(mockChatApi)) fn.mockReset();
    const now = new Date().toISOString();
    mockChatApi.listSessions.mockResolvedValue({
      sessions: [
        { id: "session-pap", companyId: "company-1", title: "Paperclip chat", model: "opus", updatedAt: now },
        { id: "session-acm", companyId: "company-2", title: "Acme chat", model: "opus", updatedAt: now },
      ],
    });
    mockChatApi.getSession.mockImplementation((id: string) =>
      Promise.resolve({ session: { id, companyId: null, title: id, model: "opus" } }),
    );
  });

  afterEach(() => {
    document.body.innerHTML = "";
    window.localStorage.clear();
  });

  it("never shows the company you left when Clippy is opened again", async () => {
    const { root, rerender } = renderClippy(container);
    await flush();

    await clickByLabel(container, "Ask Clippy");
    await flush();
    expect(container.textContent).toContain("session-pap");

    await clickByLabel(container, "Close Clippy");
    await flush();

    // Change company with Clippy shut, which is the case the old drawer
    // missed: it only tidied up its open chat while it was on screen.
    switchCompany(ACME, rerender);
    await flush();

    shownSessionIds.calls = [];
    await clickByLabel(container, "Ask Clippy");
    await flush();

    expect(shownSessionIds.calls).not.toContain("session-pap");
    expect(shownSessionIds.calls.at(-1)).toBe("session-acm");

    act(() => root.unmount());
  });

  it("remembers a chat per company, so going back reopens the one you had", async () => {
    const { root, rerender } = renderClippy(container);
    await flush();

    await clickByLabel(container, "Ask Clippy");
    await flush();
    await clickByLabel(container, "Close Clippy");
    await flush();

    switchCompany(ACME, rerender);
    await flush();
    await clickByLabel(container, "Ask Clippy");
    await flush();
    await clickByLabel(container, "Close Clippy");
    await flush();

    expect(window.localStorage.getItem(activeSessionStorageKey("company-1"))).toBe("session-pap");
    expect(window.localStorage.getItem(activeSessionStorageKey("company-2"))).toBe("session-acm");

    switchCompany(PAPERCLIP, rerender);
    await flush();

    shownSessionIds.calls = [];
    await clickByLabel(container, "Ask Clippy");
    await flush();

    expect(shownSessionIds.calls).not.toContain("session-acm");
    expect(shownSessionIds.calls.at(-1)).toBe("session-pap");

    act(() => root.unmount());
  });

  it("opens a new, unsent chat in a company with no chats, and creates nothing", async () => {
    // The old drawer created a chat here before anything was typed, and most
    // of those stayed in the list for good, titled "New chat".
    switchCompany(EMPTY, () => {});
    const { root } = renderClippy(container);
    await flush();

    await clickByLabel(container, "Ask Clippy");
    await flush();

    expect(shownSessionIds.calls.at(-1)).toBeNull();
    expect(container.querySelector("h2")?.textContent).toContain("New chat");
    expect(mockChatApi.createSession).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it("opens a chat its first send made, but not after the person has moved to another company", async () => {
    // A first send's chat used to open whenever the reply ended, and was then
    // remembered as the open chat of whichever company was on screen by then.
    const { root, rerender } = renderClippy(container);
    await flush();
    await clickByLabel(container, "Ask Clippy");
    await flush();
    await clickByLabel(container, "New chat");
    await flush();

    const madeForPaperclip = { id: "made-in-pap", companyId: "company-1", title: "New chat", model: "opus" };
    await act(async () => conversationProps.onSessionCreated?.(madeForPaperclip));
    await flush();
    expect(shownSessionIds.calls.at(-1)).toBe("made-in-pap");

    switchCompany(ACME, rerender);
    await flush();
    expect(shownSessionIds.calls.at(-1)).toBe("session-acm");

    const alsoForPaperclip = { id: "late-pap-chat", companyId: "company-1", title: "New chat", model: "opus" };
    await act(async () => conversationProps.onSessionCreated?.(alsoForPaperclip));
    await flush();
    expect(shownSessionIds.calls.at(-1)).toBe("session-acm");
    expect(window.localStorage.getItem(activeSessionStorageKey("company-2"))).toBe("session-acm");

    act(() => root.unmount());
  });

  it("starts a new chat from the header without creating one, and keeps it on screen", async () => {
    const { root } = renderClippy(container);
    await flush();
    await clickByLabel(container, "Ask Clippy");
    await flush();
    expect(shownSessionIds.calls.at(-1)).toBe("session-pap");

    await clickByLabel(container, "New chat");
    await flush();
    await flush();

    // It used to snap back to the latest chat: the company check read "no
    // chat selected" as something to fix.
    expect(shownSessionIds.calls.at(-1)).toBeNull();
    expect(mockChatApi.createSession).not.toHaveBeenCalled();

    act(() => root.unmount());
  });
});
