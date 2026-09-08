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

// Pinning is on for this person, so the pin control really renders. Without
// this the hook's own "no signed-in user, so pinning is unavailable" path
// hides every star and a test about which cards offer one would pass for the
// wrong reason.
vi.mock("@/hooks/usePinnedWorkspaces", () => ({
  usePinnedWorkspaces: () => ({
    pinned: [],
    isPinned: () => false,
    toggle: vi.fn(),
    canPin: true,
    isLoading: false,
  }),
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
    expect(labels).toContain("Tasks");
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
  it("is the home for every destination that left the main menu", async () => {
    // The menu was cut to eight entries on 2026-09-07. Nothing was deleted:
    // each of these keeps its catalog entry, so this page (and the search box,
    // which reads the same list) is where you now find it.
    const root = createRoot(container);
    await act(async () => {
      root.render(renderWithQueryClient());
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const links = Array.from(container.querySelectorAll("a"));
    const hrefFor = (label: string) =>
      links.find((el) => (el.textContent ?? "").startsWith(label))?.getAttribute("href");

    for (const [label, href] of [
      ["Projects", "/projects"],
      ["Goals", "/goals"],
      ["Automations", "/routines"],
      ["Intake queues", "/work-queues"],
      ["Memories", "/memories"],
      ["Approvals", "/approvals"],
      ["Receipts", "/receipts"],
      ["Activity", "/activity"],
      ["Org chart", "/org"],
      ["Assistants", "/assistants"],
      ["Clippy", "/clippy"],
    ] as const) {
      expect(hrefFor(label), label).toBe(href);
    }

    await act(async () => {
      root.unmount();
    });
  });

  it("offers company settings and instance settings as two separate groups", async () => {
    // Before this the page promised every workspace this company can reach
    // and did not know a single settings page existed. There is still no
    // Administration page and no new menu line: these are the real screens.
    const root = createRoot(container);
    await act(async () => {
      root.render(renderWithQueryClient());
    });

    const links = Array.from(container.querySelectorAll("a"));
    const hrefFor = (label: string) =>
      links.find((el) => (el.textContent ?? "").startsWith(label))?.getAttribute("href");

    expect(hrefFor("Company settings")).toBe("/company/settings");
    expect(hrefFor("Invites")).toBe("/company/settings/invites");
    expect(hrefFor("Secrets")).toBe("/company/settings/secrets");
    expect(hrefFor("Plugins")).toBe("/instance/settings/plugins");
    expect(hrefFor("MCP servers")).toBe("/instance/settings/external-mcp");
    expect(hrefFor("Experimental")).toBe("/instance/settings/experimental");

    const headings = Array.from(container.querySelectorAll("h2")).map((el) => el.textContent ?? "");
    expect(headings).toContain("Company settings");
    expect(headings).toContain("Instance settings");

    await act(async () => {
      root.unmount();
    });
  });

  it("says which settings affect every company, on the group and on each row", async () => {
    // The scope document is explicit that a system wide setting must not look
    // like it applies only to the company you are in. Both scopes have a page
    // called Access, so the note has to be on the row, not only the heading.
    const root = createRoot(container);
    await act(async () => {
      root.render(renderWithQueryClient());
    });

    const text = container.textContent ?? "";
    expect(text).toContain("Every company on this instance, not only the one you are in.");
    expect(text).toContain("Just the company you are in.");

    const links = Array.from(container.querySelectorAll("a"));
    const cardFor = (href: string) =>
      links.find((el) => el.getAttribute("href") === href)?.textContent ?? "";
    expect(cardFor("/instance/settings/plugins")).toContain("Every company");
    expect(cardFor("/company/settings/secrets")).toContain("This company");

    await act(async () => {
      root.unmount();
    });
  });

  it("does not offer to pin a settings page, because a pin there would be dropped", async () => {
    // Pins resolve through resolvePinnedWorkspaceItems, which only knows core
    // workspace ids and plugin routes. A star on these would look like it
    // worked and then quietly do nothing.
    const root = createRoot(container);
    await act(async () => {
      root.render(renderWithQueryClient());
    });

    const pinLabels = Array.from(container.querySelectorAll("button"))
      .map((el) => el.getAttribute("aria-label") ?? "")
      .filter((label) => label.startsWith("Pin ") || label.startsWith("Unpin "));
    expect(pinLabels.length).toBeGreaterThan(0);
    for (const forbidden of ["Pin Secrets", "Pin Plugins", "Pin Company settings", "Pin MCP servers"]) {
      expect(pinLabels, forbidden).not.toContain(forbidden);
    }

    await act(async () => {
      root.unmount();
    });
  });

  it("uses the names Barry chose, not the ones they replaced", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(renderWithQueryClient());
    });

    const labels = Array.from(container.querySelectorAll("a")).map((el) => el.textContent ?? "");
    expect(labels).toContain("Overview");
    expect(labels).toContain("Attention");
    expect(labels).toContain("Tasks");
    expect(labels).toContain("Automations");
    expect(labels).toContain("Intake queues");
    for (const oldName of ["Brief", "Inbox", "Issues", "Routines", "Work queues"]) {
      expect(labels, oldName).not.toContain(oldName);
    }

    await act(async () => {
      root.unmount();
    });
  });
});
