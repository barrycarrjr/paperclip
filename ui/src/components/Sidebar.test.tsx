// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";

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

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", issuePrefix: "PAP", name: "Paperclip" },
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
    canPin: true,
    isLoading: false,
    isSaving: false,
  }),
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

describe("Sidebar", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
    mockAgentsApi.list.mockResolvedValue([]);
    pinnedState.value = [];
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("does not flash the Workspaces link while experimental settings are loading", async () => {
    mockInstanceSettingsApi.getExperimental.mockImplementation(() => new Promise(() => {}));
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Sidebar />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).not.toContain("Workspaces");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders Projects as a top-level nav item linking to /projects", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({});
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Sidebar />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const projectsLink = [...container.querySelectorAll("a")].find(
      (anchor) => anchor.textContent?.trim() === "Projects",
    );
    expect(projectsLink?.getAttribute("href")).toBe("/projects");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders nothing extra when nothing is pinned", async () => {
    pinnedState.value = [];
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

    // Exactly one Goals link, i.e. the sidebar is unchanged for anyone who has
    // never pinned anything.
    const goals = [...container.querySelectorAll("a")].filter((a) => a.textContent === "Goals");
    expect(goals).toHaveLength(1);

    await act(async () => {
      root.unmount();
    });
  });

  it("shows a pinned workspace near the top, above the grouped sections", async () => {
    pinnedState.value = ["goals"];
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

    const links = [...container.querySelectorAll("a")];
    const goalsLinks = links.filter((a) => a.textContent === "Goals");
    // Twice: once pinned near the top, once in its usual Work section.
    expect(goalsLinks).toHaveLength(2);

    const calendarIndex = links.findIndex((a) => a.textContent === "Calendar");
    const firstGoalsIndex = links.indexOf(goalsLinks[0]);
    expect(firstGoalsIndex).toBeGreaterThan(calendarIndex);

    await act(async () => {
      root.unmount();
    });
  });

  it("does not show a pinned workspace the instance has switched off", async () => {
    pinnedState.value = ["workspaces"];
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
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

    const links = [...container.querySelectorAll("a")].filter((a) => a.textContent === "Workspaces");
    expect(links).toHaveLength(0);

    await act(async () => {
      root.unmount();
    });
  });

  it("shows the Workspaces link when isolated workspaces are enabled", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Sidebar />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const link = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent === "Workspaces");
    expect(link?.getAttribute("href")).toBe("/workspaces");

    await act(async () => {
      root.unmount();
    });
  });
});
