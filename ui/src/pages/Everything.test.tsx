// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Everything } from "./Everything";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

const companiesState: { companies: Array<{ id: string; isPortfolioRoot: boolean }> } = {
  companies: [
    { id: "company-1", isPortfolioRoot: false },
    { id: "hq", isPortfolioRoot: true },
  ],
};
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ companies: companiesState.companies }),
}));

// The URL's company, not any "currently selected" concept — see Everything.tsx's
// own comment on why this can't be sourced from useCompany()'s selection state.
const activeCompanyIdState: { value: string | null } = { value: "company-1" };
vi.mock("@/hooks/useRouteCompany", () => ({
  useActiveCompanyId: () => activeCompanyIdState.value,
}));

const setBreadcrumbs = vi.fn();
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs }),
}));

interface MockSlot {
  id: string;
  displayName: string;
  pluginKey: string;
  pluginDisplayName: string;
  routePath?: string;
}
const pluginSlotsState: { slots: MockSlot[] } = { slots: [] };
vi.mock("@/plugins/slots", () => ({
  usePluginSlots: () => ({ slots: pluginSlotsState.slots, isLoading: false, errorMessage: null }),
}));

// The page reads the instance's experimental settings to know which
// workspaces this company can actually open. Stubbed rather than mocked away
// so a test can turn the isolated-workspaces switch off and see the page stop
// offering that destination.
const experimentalState: { enableIsolatedWorkspaces: boolean } = {
  enableIsolatedWorkspaces: true,
};
vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: {
    getExperimental: async () => ({
      enableIsolatedWorkspaces: experimentalState.enableIsolatedWorkspaces,
    }),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function renderWithQueryClient() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <Everything />
    </QueryClientProvider>
  );
}

describe("Everything", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    pluginSlotsState.slots = [];
    activeCompanyIdState.value = "company-1";
    experimentalState.enableIsolatedWorkspaces = true;
    setBreadcrumbs.mockClear();
  });

  afterEach(() => {
    container.remove();
  });

  it("lists core pages but not portfolio-only pages for a non-root company", () => {
    const root = createRoot(container);
    act(() => {
      root.render(renderWithQueryClient());
    });

    const labels = Array.from(container.querySelectorAll("a")).map((el) => el.textContent ?? "");
    expect(labels).toContain("Email");
    expect(labels).toContain("Calendar");
    expect(labels).not.toContain("Portfolio Brief");

    act(() => {
      root.unmount();
    });
  });

  it("shows portfolio-only pages when the URL company is the portfolio root (HQ)", () => {
    activeCompanyIdState.value = "hq";
    const root = createRoot(container);
    act(() => {
      root.render(renderWithQueryClient());
    });

    const labels = Array.from(container.querySelectorAll("a")).map((el) => el.textContent ?? "");
    expect(labels).toContain("Portfolio Brief");

    act(() => {
      root.unmount();
    });
  });

  it("only shows plugin pages that declare a routePath (code review precedent, CommandPalette 2026-09-02)", () => {
    pluginSlotsState.slots = [
      { id: "slot-1", displayName: "Notepad", pluginKey: "notepad-plugin", pluginDisplayName: "Notes", routePath: "notepad" },
      { id: "slot-2", displayName: "Embedded Widget", pluginKey: "widget-plugin", pluginDisplayName: "Widget Plugin", routePath: undefined },
    ];
    const root = createRoot(container);
    act(() => {
      root.render(renderWithQueryClient());
    });

    const labels = Array.from(container.querySelectorAll("a")).map((el) => el.textContent ?? "");
    expect(labels.some((label) => label.includes("Notepad"))).toBe(true);
    expect(labels.some((label) => label.includes("Embedded Widget"))).toBe(false);

    const notepadLink = Array.from(container.querySelectorAll("a")).find((el) => (el.textContent ?? "").startsWith("Notepad"));
    expect(notepadLink?.getAttribute("href")).toBe("/notepad");

    act(() => {
      root.unmount();
    });
  });

  it("sets a single breadcrumb", () => {
    const root = createRoot(container);
    act(() => {
      root.render(renderWithQueryClient());
    });

    expect(setBreadcrumbs).toHaveBeenCalledWith([{ label: "Everything" }]);

    act(() => {
      root.unmount();
    });
  });

  it("stops offering Workspaces when the instance has it switched off", async () => {
    // The sidebar already hid this entry in that case. Offering it here sent
    // you to a page that silently redirected to Issues.
    experimentalState.enableIsolatedWorkspaces = false;
    const root = createRoot(container);
    await act(async () => {
      root.render(renderWithQueryClient());
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const labels = Array.from(container.querySelectorAll("a")).map((el) => el.textContent ?? "");
    expect(labels).not.toContain("Workspaces");
    // Everything else is untouched.
    expect(labels).toContain("Issues");
    expect(labels).toContain("Email");

    await act(async () => {
      root.unmount();
    });
  });

  it("offers Workspaces when it is switched on", async () => {
    experimentalState.enableIsolatedWorkspaces = true;
    const root = createRoot(container);
    await act(async () => {
      root.render(renderWithQueryClient());
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const labels = Array.from(container.querySelectorAll("a")).map((el) => el.textContent ?? "");
    expect(labels).toContain("Workspaces");

    await act(async () => {
      root.unmount();
    });
  });
});
