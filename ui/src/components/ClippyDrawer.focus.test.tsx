// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClippyDrawer } from "./ClippyDrawer";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * Closing the Clippy drawer used to drop focus on the page body, so the next
 * Tab press started again at the very top of the document. On a phone that
 * means walking the whole sidebar before reaching anything on the page.
 *
 * The real drawer is used here, not a stand in, because the fix lives in what
 * the drawer tells Radix to do when it closes.
 */

const companyState = vi.hoisted(() => ({
  companies: [
    { id: "company-1", name: "Paperclip", issuePrefix: "PAP", isPortfolioRoot: false },
  ] as Array<Record<string, unknown>>,
  selectedCompanyId: "company-1" as string | null,
}));

const mockChatApi = vi.hoisted(() => ({
  listSessions: vi.fn(),
  createSession: vi.fn(),
  patchSession: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("@/lib/router", () => ({
  useParams: () => ({ companyPrefix: "PAP" }),
}));

vi.mock("../api/chat", () => ({ chatApi: mockChatApi }));

vi.mock("./ClippyConversation", () => ({
  ClippyConversation: () => <div data-testid="conversation" />,
}));

vi.mock("../lib/clippy-stream-manager", () => ({
  clippyStreamManager: {
    subscribe: () => () => {},
    getSnapshot: () => ({ streaming: false }),
    subscribeGlobal: () => () => {},
    getPendingActionCount: () => 0,
  },
}));

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function launcher(): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find((candidate) =>
    candidate.getAttribute("aria-label")?.startsWith("Open Clippy"),
  );
  expect(button, "no Clippy launcher on the page").not.toBeUndefined();
  return button as HTMLButtonElement;
}

describe("closing the Clippy drawer", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    window.localStorage.clear();
    mockChatApi.listSessions.mockReset();
    mockChatApi.createSession.mockReset();
    mockChatApi.listSessions.mockResolvedValue({
      sessions: [{ id: "session-pap", companyId: "company-1", title: "Paperclip chat", model: "opus" }],
    });
    root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <ClippyDrawer />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("puts focus back on the round button that opened it", async () => {
    const openButton = launcher();
    openButton.focus();

    await act(async () => {
      openButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.querySelector('[data-slot="sheet-content"]')).not.toBeNull();
    expect(document.activeElement).not.toBe(openButton);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    // Radix hands focus back a beat after the drawer has gone, not in the same
    // turn, so give it that beat before looking. Without this wait the check
    // passes or fails depending on timing.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull();
    expect(document.activeElement).toBe(launcher());
  });
});
