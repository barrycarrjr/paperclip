// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PortfolioApprovals } from "./PortfolioApprovals";

const listPortfolio = vi.fn();
const approve = vi.fn();
const reject = vi.fn();
const listAgents = vi.fn();
const setBreadcrumbs = vi.fn();

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

vi.mock("../api/approvals", () => ({
  approvalsApi: {
    listPortfolio: (...args: unknown[]) => listPortfolio(...args),
    approve: (...args: unknown[]) => approve(...args),
    reject: (...args: unknown[]) => reject(...args),
  },
}));

vi.mock("../api/agents", () => ({
  agentsApi: { list: (...args: unknown[]) => listAgents(...args) },
}));

vi.mock("../hooks/useRouteCompany", () => ({
  useActiveCompanyId: () => "hq",
  useIsActiveCompanyPortfolioRoot: () => true,
}));

vi.mock("../hooks/usePortfolioCompanyOptions", () => ({
  usePortfolioCompanyOptions: () => [],
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs }),
}));

vi.mock("../components/CompanyPatternIcon", () => ({
  CompanyPatternIcon: () => <span aria-hidden />,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// The production types are intentionally larger than these view fixtures.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function company(overrides: Record<string, unknown>): any {
  return { id: "m3", name: "M3 Media LLC", issuePrefix: "MME", isPortfolioRoot: false, status: "active", logoUrl: null, brandColor: null, ...overrides };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function draft(id: string, text: string, overrides: Record<string, unknown> = {}): any {
  return {
    id,
    companyId: "m3",
    type: "outbound_tool_draft",
    requestedByAgentId: "agent-1",
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

function checkboxByLabel(container: HTMLElement, label: string) {
  return container.querySelector<HTMLButtonElement>(`button[role="checkbox"][aria-label="${label}"]`);
}

function buttonByText(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === text);
}

describe("PortfolioApprovals", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    listPortfolio.mockReset();
    approve.mockReset();
    reject.mockReset();
    listAgents.mockReset();
    listPortfolio.mockResolvedValue({
      companies: [
        company({ id: "hq", name: "HQ", issuePrefix: "HQ", isPortfolioRoot: true }),
        company({}),
        company({ id: "empty", name: "Quiet Co", issuePrefix: "QC" }),
      ],
      approvals: [
        draft("a1", "Samuel, we appreciate that!"),
        draft("a2", "Thank you for the five-star rating!"),
        draft("a3", "Budget please", { type: "budget_override_required", payload: { summary: "Budget please" } }),
      ],
    });
    listAgents.mockResolvedValue([{ id: "agent-1", companyId: "m3", name: "M3 Review Responder" }]);
    approve.mockImplementation(async (id: string) => ({ id }));
    reject.mockImplementation(async (id: string) => ({ id }));

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

  async function render() {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PortfolioApprovals />
        </QueryClientProvider>,
      );
    });
    await settle();
  }

  it("shows what each request says and who asked, and skips companies with nothing waiting", async () => {
    await render();

    expect(container.textContent).toContain("Samuel, we appreciate that!");
    expect(container.textContent).toContain("Thank you for the five-star rating!");
    expect(container.textContent).toContain("M3 Review Responder");
    expect(container.textContent).toContain("M3 Media LLC");
    expect(container.textContent).not.toContain("Quiet Co");
    expect(container.textContent).not.toContain("No approvals match");
    expect(container.querySelector('a[href="/MME/approvals/a1"]')?.textContent).toBe("View details");
  });

  it("selects every decidable request at once and approves them together", async () => {
    await render();

    // The budget override cannot be bulk-decided, so it is not counted.
    expect(container.textContent).toContain("Select all (2)");
    await act(async () => checkboxByLabel(container, "Select all approvals")!.click());
    expect(container.textContent).toContain("2 selected");

    await act(async () => buttonByText(container, "Approve 2")!.click());
    await settle();

    expect(approve.mock.calls.map((c) => c[0])).toEqual(["a1", "a2"]);
    expect(reject).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("selected");
  });

  it("rejects only the ticked request and reports one that failed, keeping it ticked", async () => {
    reject.mockRejectedValueOnce(new Error("Approval is not pending"));
    await render();

    const boxes = Array.from(container.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]')).filter((b) =>
      b.getAttribute("aria-label")?.startsWith("Select ") && !b.getAttribute("aria-label")?.startsWith("Select all"),
    );
    expect(boxes).toHaveLength(2);
    await act(async () => boxes[1]!.click());
    expect(container.textContent).toContain("1 selected");

    await act(async () => buttonByText(container, "Reject 1")!.click());
    await settle();

    expect(reject.mock.calls.map((c) => c[0])).toEqual(["a2"]);
    expect(container.textContent).toContain("Could not reject 1 of 1: Approval is not pending");
    expect(container.textContent).toContain("1 selected");
  });
});
