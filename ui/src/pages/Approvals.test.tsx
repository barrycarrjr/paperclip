// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Approvals } from "./Approvals";

const list = vi.fn();
const approve = vi.fn();
const reject = vi.fn();
const navigate = vi.fn();

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useNavigate: () => navigate,
  useLocation: () => ({ pathname: "/MME/approvals/pending" }),
}));

vi.mock("../api/approvals", () => ({
  approvalsApi: {
    list: (...args: unknown[]) => list(...args),
    approve: (...args: unknown[]) => approve(...args),
    reject: (...args: unknown[]) => reject(...args),
  },
}));

vi.mock("../api/agents", () => ({
  agentsApi: { list: async () => [] },
}));

vi.mock("../hooks/useRouteCompany", () => ({
  useActiveCompanyId: () => "m3",
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../components/PageTabBar", () => ({
  PageTabBar: () => <div />,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function draft(id: string, text: string, overrides: Record<string, unknown> = {}): any {
  return {
    id,
    companyId: "m3",
    type: "outbound_tool_draft",
    requestedByAgentId: null,
    requestedByUserId: null,
    status: "pending",
    payload: { toolName: "google-business:reply_review", parameters: { comment: text }, summary: text },
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function settle() {
  for (let index = 0; index < 8; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("Approvals bulk selection", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    list.mockReset();
    approve.mockReset();
    reject.mockReset();
    navigate.mockReset();
    list.mockResolvedValue([
      draft("a1", "Samuel, we appreciate that!"),
      draft("a2", "Thank you for the five-star rating!"),
      draft("done", "Already sent", { status: "approved" }),
    ]);
    approve.mockImplementation(async (id: string) => ({ id }));

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    container.remove();
  });

  it("approves every pending card from one bar without leaving the list", async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Approvals />
        </QueryClientProvider>,
      );
    });
    await settle();

    expect(container.textContent).toContain("Select all (2)");
    const selectAll = container.querySelector<HTMLButtonElement>('button[role="checkbox"][aria-label="Select all approvals"]');
    await act(async () => selectAll!.click());
    expect(container.textContent).toContain("2 selected");

    const approveAll = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Approve 2");
    await act(async () => approveAll!.click());
    await settle();

    expect(approve.mock.calls.map((c) => c[0]).sort()).toEqual(["a1", "a2"]);
    // A single Approve opens the decided approval; a bulk one stays on the list.
    expect(navigate).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("selected");
  });
});
