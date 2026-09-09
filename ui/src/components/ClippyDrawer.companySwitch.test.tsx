// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClippyDrawer, activeSessionStorageKey } from "./ClippyDrawer";

const PAPERCLIP = { id: "company-1", name: "Paperclip", issuePrefix: "PAP", isPortfolioRoot: false };
const ACME = { id: "company-2", name: "Acme", issuePrefix: "ACM", isPortfolioRoot: false };

const companyState = vi.hoisted(() => ({
  companies: [] as Array<Record<string, unknown>>,
  selectedCompanyId: "company-1" as string | null,
}));

const routeState = vi.hoisted(() => ({
  companyPrefix: "PAP" as string | undefined,
}));

const mockChatApi = vi.hoisted(() => ({
  listSessions: vi.fn(),
  createSession: vi.fn(),
  patchSession: vi.fn(),
}));

/** Every sessionId the conversation pane has been asked to show, in order. */
const shownSessionIds = vi.hoisted(() => ({ calls: [] as Array<string | null> }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

// The drawer reads its company out of the web address (useActiveCompanyId).
vi.mock("@/lib/router", () => ({
  useParams: () => ({ companyPrefix: routeState.companyPrefix }),
}));

vi.mock("../api/chat", () => ({ chatApi: mockChatApi }));

vi.mock("./ClippyConversation", () => ({
  ClippyConversation: ({ sessionId }: { sessionId: string | null }) => {
    shownSessionIds.calls.push(sessionId);
    return <div data-testid="conversation">{sessionId ?? "no chat"}</div>;
  },
}));

vi.mock("../lib/clippy-stream-manager", () => ({
  clippyStreamManager: {
    subscribe: () => () => {},
    getSnapshot: () => ({ streaming: false }),
    subscribeGlobal: () => () => {},
    getPendingActionCount: () => 0,
  },
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
  SheetContent: ({
    children,
    side: _side,
    showCloseButton: _showCloseButton,
    ...props
  }: ComponentProps<"div"> & { side?: string; showCloseButton?: boolean }) => <div {...props}>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, type = "button", ...props }: ComponentProps<"button">) => (
    <button type={type} onClick={onClick} {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/input", async () => {
  const React = await import("react");
  return {
    Input: React.forwardRef<HTMLInputElement, ComponentProps<"input">>(
      function InputMock(props, ref) {
        return <input ref={ref} {...props} />;
      },
    ),
  };
});

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
    <button type="button" onClick={() => onSelect?.()}>{children}</button>
  ),
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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

function renderDrawer(container: HTMLDivElement) {
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
          <ClippyDrawer />
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

describe("ClippyDrawer across a company change", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    window.localStorage.clear();
    companyState.companies = [PAPERCLIP, ACME];
    companyState.selectedCompanyId = "company-1";
    routeState.companyPrefix = "PAP";
    shownSessionIds.calls = [];
    mockChatApi.listSessions.mockReset();
    mockChatApi.createSession.mockReset();
    mockChatApi.listSessions.mockResolvedValue({
      sessions: [
        { id: "session-pap", companyId: "company-1", title: "Paperclip chat", model: "opus" },
        { id: "session-acm", companyId: "company-2", title: "Acme chat", model: "opus" },
      ],
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    window.localStorage.clear();
  });

  it("never shows the company you left when the drawer is opened again", async () => {
    const { root, rerender } = renderDrawer(container);
    await flush();

    await clickByLabel(container, "Open Clippy");
    await flush();
    expect(container.textContent).toContain("session-pap");

    await clickByLabel(container, "Close");
    await flush();

    // Change company with the drawer shut, which is the case the drawer used
    // to miss: it only tidied up its open chat while it was on screen.
    companyState.selectedCompanyId = "company-2";
    routeState.companyPrefix = "ACM";
    rerender();
    await flush();

    shownSessionIds.calls = [];
    await clickByLabel(container, "Open Clippy");
    await flush();

    expect(shownSessionIds.calls).not.toContain("session-pap");
    expect(shownSessionIds.calls.at(-1)).toBe("session-acm");

    act(() => root.unmount());
  });

  it("remembers a chat per company, so going back reopens the one you had", async () => {
    const { root, rerender } = renderDrawer(container);
    await flush();

    await clickByLabel(container, "Open Clippy");
    await flush();
    await clickByLabel(container, "Close");
    await flush();

    companyState.selectedCompanyId = "company-2";
    routeState.companyPrefix = "ACM";
    rerender();
    await flush();
    await clickByLabel(container, "Open Clippy");
    await flush();
    await clickByLabel(container, "Close");
    await flush();

    expect(window.localStorage.getItem(activeSessionStorageKey("company-1"))).toBe("session-pap");
    expect(window.localStorage.getItem(activeSessionStorageKey("company-2"))).toBe("session-acm");

    companyState.selectedCompanyId = "company-1";
    routeState.companyPrefix = "PAP";
    rerender();
    await flush();

    shownSessionIds.calls = [];
    await clickByLabel(container, "Open Clippy");
    await flush();

    expect(shownSessionIds.calls).not.toContain("session-acm");
    expect(shownSessionIds.calls.at(-1)).toBe("session-pap");

    act(() => root.unmount());
  });
});
