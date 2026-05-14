// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssigneePicker } from "./AssigneePicker";

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockAccessApi = vi.hoisted(() => ({
  listUserDirectory: vi.fn(),
}));

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/access", () => ({ accessApi: mockAccessApi }));
vi.mock("../api/auth", () => ({ authApi: mockAuthApi }));

vi.mock("../lib/recent-assignees", () => ({
  getRecentAssigneeIds: () => [],
  getRecentAssigneeSelectionIds: () => [],
  sortAgentsByRecency: (agents: unknown[]) => agents,
  trackRecentAssignee: vi.fn(),
  trackRecentAssigneeUser: vi.fn(),
}));

vi.mock("../lib/assignees", () => ({
  formatAssigneeUserLabel: (userId: string | null | undefined) => (userId ? "Me" : null),
}));

vi.mock("./Identity", () => ({
  Identity: ({ name }: { name: string }) => <span data-testid="identity">{name}</span>,
}));

vi.mock("./AgentIconPicker", () => ({
  AgentIcon: () => null,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div data-testid="popover">{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div data-testid="popover-content">{children}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("AssigneePicker", () => {
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockAgentsApi.list.mockResolvedValue([
      { id: "agent-1", name: "Mike", role: "engineer", title: null, status: "active", icon: null },
    ]);
    mockAccessApi.listUserDirectory.mockResolvedValue({ users: [] });
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "user-1" } });
  });

  afterEach(() => {
    document.body.removeChild(container);
  });

  function render(props: Partial<Parameters<typeof AssigneePicker>[0]>) {
    const root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AssigneePicker
            companyId="company-1"
            assigneeAgentId={null}
            assigneeUserId={null}
            onChange={vi.fn()}
            {...props}
          />
        </QueryClientProvider>,
      );
    });
    return root;
  }

  it("renders 'Unassigned' when nothing is assigned", async () => {
    render({});
    await flush();
    expect(container.textContent).toContain("Unassigned");
  });

  it("renders the assignee's name when an agent is assigned via prop", async () => {
    render({ assigneeAgentId: "agent-1", assigneeAgentName: "Mike" });
    await flush();
    expect(container.textContent).toContain("Mike");
  });

  it("calls onChange when a 'No assignee' option is selected", async () => {
    const onChange = vi.fn();
    render({ assigneeAgentId: "agent-1", assigneeAgentName: "Mike", onChange });
    await flush();
    // Open is implicit because popover content always renders in the mock.
    const button = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "No assignee",
    );
    expect(button).toBeTruthy();
    act(() => {
      button!.click();
    });
    expect(onChange).toHaveBeenCalledWith({ assigneeAgentId: null, assigneeUserId: null });
  });
});
