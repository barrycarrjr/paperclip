// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";
import { HQ_DEFAULT_PINNED_WORKSPACE_IDS } from "../lib/hq-default-pins";

const mockHeartbeatsApi = vi.hoisted(() => ({
  liveRunsForCompany: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  NavLink: ({ to, children, className, ...props }: {
    to: string;
    children: ReactNode;
    className?: string | ((state: { isActive: boolean }) => string);
  }) => (
    <a
      href={to}
      className={typeof className === "function" ? className({ isActive: false }) : className}
      {...props}
    >
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    openNewIssue: vi.fn(),
  }),
}));

// Mutable so a test can put the sidebar in HQ (the portfolio root), where the
// old menu grew an extra eleven-entry Portfolio block on top of everything
// else.
const companyState: { value: { id: string; issuePrefix: string; name: string; isPortfolioRoot?: boolean } } = {
  value: { id: "company-1", issuePrefix: "PAP", name: "Paperclip" },
};
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: companyState.value.id,
    selectedCompany: companyState.value,
  }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
    setSidebarOpen: vi.fn(),
  }),
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../hooks/useInboxBadge", () => ({
  useInboxBadge: () => ({ inbox: 0, failedRuns: 0 }),
}));

// Email only appears for a company that actually has a mailbox. Stubbed as
// present so the "eight destinations" assertions see the whole menu.
// pluginId is tracked apart from hasMailbox on purpose: the email add-on is
// installed for the whole instance, so HQ can have the add-on and still have
// no mailbox of its own. That combination is what puts Email on HQ's menu
// pointing at the portfolio-wide mail page.
const emailState: { hasMailbox: boolean; installed: boolean } = {
  hasMailbox: true,
  installed: true,
};
vi.mock("../hooks/useEmailToolsPlugin", () => ({
  useEmailToolsPlugin: () => ({
    pluginId: emailState.installed ? "email-plugin" : null,
    hasMailboxForCompany: emailState.hasMailbox,
    isLoading: false,
  }),
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotOutlet: () => null,
  usePluginSlots: () => ({ slots: [], isLoading: false, errorMessage: null }),
}));

// Pinning is a per-user preference; the sidebar only reads it to render the
// "Pinned tools" block. Nothing pinned means that block renders nothing, which
// is the state every other assertion in this file assumes.
const pinnedState: { value: string[] } = { value: [] };
vi.mock("../hooks/usePinnedWorkspaces", () => ({
  usePinnedWorkspaces: () => ({
    pinned: pinnedState.value,
    isPinned: (id: string) => pinnedState.value.includes(id),
    toggle: () => {},
    replaceAll: async () => {},
    canPin: true,
    ownerId: "user-1",
    isLoading: false,
    pinsLoaded: true,
    isSaving: false,
  }),
}));

// HQ's one time starting pins. Writing them is its own hook with its own
// tests (useHqDefaultPins.test.tsx); here we only care what the sidebar draws
// for a given pin list, so it is stubbed out to keep these tests from writing
// anything.
vi.mock("../hooks/useHqDefaultPins", () => ({
  useHqDefaultPins: () => {},
}));

vi.mock("./SidebarCompanyMenu", () => ({
  SidebarCompanyMenu: () => <div>Company menu</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

/** The eight destinations agreed in the scope document, in order. */
const AGREED_MENU = ["Email", "Calendar", "Overview", "Attention", "Team", "Work", "Everything"];

/**
 * The same menu in HQ. Email and Calendar are not offered automatically there,
 * because HQ has neither a mailbox nor a calendar of its own, so with nothing
 * pinned the top section is empty and the menu starts at Overview.
 */
const HQ_MENU = ["Overview", "Attention", "Team", "Work", "Everything"];

describe("Sidebar", () => {
  let container: HTMLDivElement;

  async function renderSidebar() {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Sidebar />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    return root;
  }

  function menuLabels() {
    return [...container.querySelectorAll("a")].map((anchor) => anchor.textContent?.trim() ?? "");
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
    mockAgentsApi.list.mockResolvedValue([]);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({});
    pinnedState.value = [];
    emailState.hasMailbox = true;
    emailState.installed = true;
    companyState.value = { id: "company-1", issuePrefix: "PAP", name: "Paperclip" };
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("shows the agreed short menu, in the agreed order", async () => {
    const root = await renderSidebar();

    expect(menuLabels()).toEqual(AGREED_MENU);

    await act(async () => {
      root.unmount();
    });
  });

  it("leaves search and Start work to the top bar, and keeps New issue", async () => {
    // Both used to sit here as well, so the same two controls appeared twice
    // on one screen once the top bar gained them.
    const root = await renderSidebar();

    const buttonText = [...container.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(buttonText.some((text) => text.includes("What do you want done?"))).toBe(false);
    expect(container.querySelector('[aria-label="Search (⌘K)"]')).toBeNull();
    expect(buttonText.some((text) => text.includes("New issue"))).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });

  it("groups the menu under the two headings from the mockup", async () => {
    const root = await renderSidebar();

    expect(container.textContent).toContain("Your workspaces");
    expect(container.textContent).toContain("Control center");

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps each renamed destination on its original route", async () => {
    // The names a person reads changed; the addresses did not, so an existing
    // saved link still works and now reads the new name when it lands.
    const root = await renderSidebar();

    const hrefFor = (label: string) =>
      [...container.querySelectorAll("a")]
        .find((anchor) => anchor.textContent?.trim() === label)
        ?.getAttribute("href");

    expect(hrefFor("Overview")).toBe("/brief");
    expect(hrefFor("Attention")).toBe("/inbox");
    expect(hrefFor("Work")).toBe("/issues");
    expect(hrefFor("Team")).toBe("/agents/all");
    expect(hrefFor("Everything")).toBe("/everything");

    await act(async () => {
      root.unmount();
    });
  });

  it("no longer lists the destinations that moved to the Everything page", async () => {
    const root = await renderSidebar();

    const labels = menuLabels();
    for (const moved of [
      "Projects",
      "Goals",
      "Automations",
      "Intake queues",
      "Memories",
      "Approvals",
      "Receipts",
      "Activity",
      "Org chart",
      "All agents",
      "Assistants",
      "Clippy",
      "Workspaces",
    ]) {
      expect(labels, moved).not.toContain(moved);
    }

    await act(async () => {
      root.unmount();
    });
  });

  it("uses the new names, not the old ones", async () => {
    const root = await renderSidebar();

    const labels = menuLabels();
    for (const oldName of ["Brief", "Inbox", "Issues", "Routines", "Work queues"]) {
      expect(labels, oldName).not.toContain(oldName);
    }

    await act(async () => {
      root.unmount();
    });
  });

  it("drops Email for a company with no mailbox and leaves the rest alone", async () => {
    emailState.hasMailbox = false;
    const root = await renderSidebar();

    expect(menuLabels()).toEqual(AGREED_MENU.filter((label) => label !== "Email"));

    await act(async () => {
      root.unmount();
    });
  });

  it("does not grow a Portfolio block on HQ any more", async () => {
    // Those eleven pages are still reachable: they keep their catalog entries,
    // so HQ still lists them on the Everything page and in the search box, and
    // they are pinned for the person the first time they open HQ.
    companyState.value = { id: "hq", issuePrefix: "HQ", name: "HQ", isPortfolioRoot: true };
    const root = await renderSidebar();

    expect(container.textContent).not.toContain("Portfolio");

    await act(async () => {
      root.unmount();
    });
  });

  it("offers HQ no Email and no Calendar of its own, only what is pinned", async () => {
    // HQ is where you look across companies. It has no mailbox and no calendar
    // of its own, so offering either would send you to an empty page.
    companyState.value = { id: "hq", issuePrefix: "HQ", name: "HQ", isPortfolioRoot: true };
    emailState.hasMailbox = true;
    emailState.installed = true;
    pinnedState.value = [];
    const root = await renderSidebar();

    expect(menuLabels()).toEqual(HQ_MENU);

    await act(async () => {
      root.unmount();
    });
  });

  it("fills HQ's top section with the pages it starts pinned with", async () => {
    companyState.value = { id: "hq", issuePrefix: "HQ", name: "HQ", isPortfolioRoot: true };
    pinnedState.value = [...HQ_DEFAULT_PINNED_WORKSPACE_IDS];
    const root = await renderSidebar();

    // Every line above Overview is a pin. Still no automatic Email or
    // Calendar: "Portfolio Calendar" is a pinned page with its own name.
    expect(menuLabels()).toEqual([
      "Portfolio Brief",
      "Portfolio Approvals",
      "Portfolio Issues",
      "Portfolio Directives",
      "Portfolio Agents",
      "Portfolio Activity",
      "Portfolio Receipts",
      "Portfolio Routines",
      "Portfolio Calendar",
      "Portfolio Email",
      "Portfolio Costs",
      ...HQ_MENU,
    ]);

    await act(async () => {
      root.unmount();
    });
  });

  it("still gives an ordinary company Email and Calendar without being asked", async () => {
    // Change 1 is HQ only. Everywhere else these two keep appearing on their
    // own, with nothing pinned and nothing set up.
    companyState.value = { id: "company-1", issuePrefix: "PAP", name: "Paperclip" };
    emailState.hasMailbox = true;
    pinnedState.value = [];
    const root = await renderSidebar();

    const labels = menuLabels();
    expect(labels).toContain("Email");
    expect(labels).toContain("Calendar");
    expect(labels.indexOf("Email")).toBeLessThan(labels.indexOf("Calendar"));
    expect(labels.indexOf("Calendar")).toBeLessThan(labels.indexOf("Overview"));

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps Calendar in an ordinary company that has no mailbox", async () => {
    emailState.hasMailbox = false;
    const root = await renderSidebar();

    expect(menuLabels()).toContain("Calendar");

    await act(async () => {
      root.unmount();
    });
  });

  it("gives an ordinary company with no mailbox no Email link at all", async () => {
    emailState.hasMailbox = false;
    const root = await renderSidebar();

    const labels = menuLabels();
    expect(labels).not.toContain("Email");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders nothing extra when nothing is pinned", async () => {
    pinnedState.value = [];
    const root = await renderSidebar();

    expect(menuLabels()).toEqual(AGREED_MENU);

    await act(async () => {
      root.unmount();
    });
  });

  it("shows a pinned workspace with the daily shortcuts, above the control center", async () => {
    pinnedState.value = ["goals"];
    const root = await renderSidebar();

    const labels = menuLabels();
    expect(labels.filter((label) => label === "Goals")).toHaveLength(1);
    expect(labels.indexOf("Goals")).toBeGreaterThan(labels.indexOf("Calendar"));
    expect(labels.indexOf("Goals")).toBeLessThan(labels.indexOf("Overview"));

    await act(async () => {
      root.unmount();
    });
  });

  it("shows a pinned destination under its new name", async () => {
    pinnedState.value = ["routines"];
    const root = await renderSidebar();

    expect(menuLabels()).toContain("Automations");
    expect(menuLabels()).not.toContain("Routines");

    await act(async () => {
      root.unmount();
    });
  });

  it("does not show a pinned workspace the instance has switched off", async () => {
    pinnedState.value = ["workspaces"];
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    const root = await renderSidebar();

    expect(menuLabels()).not.toContain("Workspaces");

    await act(async () => {
      root.unmount();
    });
  });

  it("shows a pinned workspace once the instance switches it on", async () => {
    pinnedState.value = ["workspaces"];
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    const root = await renderSidebar();

    const link = [...container.querySelectorAll("a")].find(
      (anchor) => anchor.textContent?.trim() === "Workspaces",
    );
    expect(link?.getAttribute("href")).toBe("/workspaces");

    await act(async () => {
      root.unmount();
    });
  });

  it("does not flash a pinned experimental workspace while the settings are loading", async () => {
    pinnedState.value = ["workspaces"];
    mockInstanceSettingsApi.getExperimental.mockImplementation(() => new Promise(() => {}));
    const root = await renderSidebar();

    expect(container.textContent).not.toContain("Workspaces");

    await act(async () => {
      root.unmount();
    });
  });
});
