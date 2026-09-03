// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1" as string | null,
  selectedCompany: null as { isPortfolioRoot: boolean } | null,
}));

const pluginSlotsState = vi.hoisted(() => ({
  slots: [] as Array<{
    id: string;
    displayName: string;
    routePath?: string;
    pluginKey: string;
    pluginDisplayName: string;
  }>,
}));

const dialogState = vi.hoisted(() => ({
  openNewIssue: vi.fn(),
  openNewAgent: vi.fn(),
}));

const sidebarState = vi.hoisted(() => ({
  isMobile: false,
  setSidebarOpen: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockProjectsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("@/plugins/slots", () => ({
  usePluginSlots: () => ({ slots: pluginSlotsState.slots, isLoading: false, errorMessage: null }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => dialogState,
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => sidebarState,
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/projects", () => ({
  projectsApi: mockProjectsApi,
}));

vi.mock("./Identity", () => ({
  Identity: ({ name }: { name: string }) => <span>{name}</span>,
}));

vi.mock("@/components/ui/command", () => ({
  CommandDialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
  CommandEmpty: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandInput: ({
    value,
    onValueChange,
  }: {
    value: string;
    onValueChange: (value: string) => void;
  }) => (
    <div>
      <input
        aria-label="Command search"
        value={value}
        onChange={(event) => onValueChange(event.currentTarget.value)}
      />
      <button type="button" aria-label="Set query" onClick={() => onValueChange("pull/3303")} />
    </div>
  ),
  CommandItem: ({
    children,
    onSelect,
  }: {
    children: ReactNode;
    onSelect?: () => void;
  }) => <button onClick={onSelect}>{children}</button>,
  CommandList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandSeparator: () => <hr />,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function renderWithQueryClient(node: ReactNode, container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        {node}
      </QueryClientProvider>,
    );
  });

  return { root, queryClient };
}

describe("CommandPalette", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    dialogState.openNewIssue.mockReset();
    dialogState.openNewAgent.mockReset();
    sidebarState.setSidebarOpen.mockReset();
    mockIssuesApi.list.mockReset();
    mockAgentsApi.list.mockReset();
    mockProjectsApi.list.mockReset();
    mockIssuesApi.list.mockResolvedValue([]);
    mockAgentsApi.list.mockResolvedValue([]);
    mockProjectsApi.list.mockResolvedValue([]);
    companyState.selectedCompanyId = "company-1";
    companyState.selectedCompany = { isPortfolioRoot: false };
    pluginSlotsState.slots = [];
  });

  function open() {
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    });
  }

  function itemLabels(): string[] {
    return Array.from(container.querySelectorAll("button")).map((el) => el.textContent ?? "");
  }

  afterEach(() => {
    container.remove();
  });

  it("includes routine execution issues in search queries", async () => {
    const { root } = renderWithQueryClient(<CommandPalette />, container);

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    });

    const setQueryButton = container.querySelector('button[aria-label="Set query"]');
    expect(setQueryButton).not.toBeNull();

    act(() => {
      setQueryButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1", {
        q: "pull/3303",
        limit: 10,
        includeRoutineExecutions: true,
      });
    });

    act(() => {
      root.unmount();
    });
  });

  it("lists Email, Clippy and the other pages the audit found missing (B06)", async () => {
    // Regression for docs/plans/2026-09-02-ux-control-center-preservation.md
    // B06: the palette's navigation catalog used to be a separate
    // hand-copied list that never included Email, Clippy, Routines,
    // Work queues, Assistants, Memories, Approvals or Receipts. Labels here
    // must match SidebarMenu.tsx's existing names, not a proposed future
    // rename (see workspace-catalog.ts's file comment) — a first version of
    // this test asserted "Automations"/"Intake queues", which would have
    // pinned exactly that mismatch as if it were correct.
    const { root } = renderWithQueryClient(<CommandPalette />, container);
    open();
    await flush();

    const labels = itemLabels().join(" | ");
    for (const expected of ["Email", "Clippy", "Routines", "Work queues", "Assistants", "Memories", "Approvals", "Receipts"]) {
      expect(labels).toContain(expected);
    }

    act(() => {
      root.unmount();
    });
  });

  it("only shows the Portfolio group for the portfolio-root company", async () => {
    const { root: nonRootRoot } = renderWithQueryClient(<CommandPalette />, container);
    open();
    await flush();
    expect(itemLabels().join(" | ")).not.toContain("Portfolio Email");
    act(() => {
      nonRootRoot.unmount();
    });

    const rootContainer = document.createElement("div");
    document.body.appendChild(rootContainer);
    companyState.selectedCompany = { isPortfolioRoot: true };
    const { root: portfolioRoot } = renderWithQueryClient(<CommandPalette />, rootContainer);
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    });
    await flush();
    // Regression: portfolio-approvals/portfolio-activity/portfolio-receipts
    // were previously in company-routes.ts's route-root list but never
    // surfaced here even for HQ.
    const portfolioLabels = Array.from(rootContainer.querySelectorAll("button")).map((el) => el.textContent ?? "").join(" | ");
    expect(portfolioLabels).toContain("Portfolio Email");
    expect(portfolioLabels).toContain("Portfolio Approvals");
    expect(portfolioLabels).toContain("Portfolio Activity");
    expect(portfolioLabels).toContain("Portfolio Receipts");

    act(() => {
      portfolioRoot.unmount();
    });
    rootContainer.remove();
  });

  it("lists installed plugin pages by their real display name and navigates to their real route", async () => {
    pluginSlotsState.slots = [
      { id: "slot-1", displayName: "Notepad", routePath: "notepad", pluginKey: "notepad", pluginDisplayName: "Notepad" },
    ];
    const { root } = renderWithQueryClient(<CommandPalette />, container);
    open();
    await flush();

    const notepadButton = Array.from(container.querySelectorAll("button")).find((el) =>
      (el.textContent ?? "").includes("Notepad"),
    );
    expect(notepadButton).toBeTruthy();

    act(() => {
      root.unmount();
    });
  });

  it("does not render a page slot with no routePath as a navigable item (code review, 2026-09-02)", async () => {
    // A "page" slot type can legally omit routePath (e.g. a page meant to be
    // embedded elsewhere, not top-level navigable). The Plugins group's
    // visibility guard used to check the unfiltered slot count, so a
    // routePath-less-only install would show an empty "Plugins" heading with
    // nothing clickable under it — fixed by filtering before both the guard
    // and the render. This asserts the item itself never renders; it can't
    // assert the heading is absent too, since CommandGroup is mocked here
    // without its `heading` prop.
    pluginSlotsState.slots = [
      { id: "slot-1", displayName: "Embedded Widget", routePath: undefined, pluginKey: "widget-plugin", pluginDisplayName: "Widget Plugin" },
    ];
    const { root } = renderWithQueryClient(<CommandPalette />, container);
    open();
    await flush();

    const widgetButton = Array.from(container.querySelectorAll("button")).find((el) =>
      (el.textContent ?? "").includes("Embedded Widget"),
    );
    expect(widgetButton).toBeUndefined();

    act(() => {
      root.unmount();
    });
  });
});
