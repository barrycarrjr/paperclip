// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BudgetPolicySummary } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../context/ToastContext";
import { ToastViewport } from "../components/ToastViewport";
import { Costs } from "./Costs";

const mockBudgetsApi = vi.hoisted(() => ({
  overview: vi.fn(),
  upsertPolicy: vi.fn(),
  resolveIncident: vi.fn(),
}));

vi.mock("../api/budgets", () => ({
  budgetsApi: mockBudgetsApi,
}));

// Every spend figure stays loading: these tests are about the budget cards.
vi.mock("../api/costs", () => ({
  costsApi: new Proxy({}, { get: () => () => new Promise(() => {}) }),
}));

vi.mock("../hooks/useRouteCompany", () => ({
  useActiveCompanyId: () => "company-1",
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function budget(scopeId: string, scopeName: string): BudgetPolicySummary {
  return {
    policyId: `policy-${scopeId}`,
    companyId: "company-1",
    scopeType: "agent",
    scopeId,
    scopeName,
    metric: "billed_cents",
    windowKind: "calendar_month_utc",
    amount: 5000,
    observedAmount: 0,
    remainingAmount: 5000,
    utilizationPercent: 0,
    warnPercent: 80,
    hardStopEnabled: true,
    notifyEnabled: true,
    isActive: true,
    status: "ok",
    paused: false,
    pauseReason: null,
    windowStart: new Date("2026-10-01T00:00:00Z"),
    windowEnd: new Date("2026-11-01T00:00:00Z"),
  };
}

/**
 * One save serves every budget card on the page. A card whose save failed
 * keeps the amount that was typed, so its failure message is the only sign
 * that the amount never went through.
 */
describe("Costs, saving budgets", () => {
  let container: HTMLDivElement;
  let root: Root;
  // Kept while the page is left and come back to, as the app's is.
  let queryClient: QueryClient | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = null;
    mockBudgetsApi.overview.mockResolvedValue({
      companyId: "company-1",
      policies: [budget("agent-ada", "Ada"), budget("agent-bo", "Bo")],
      activeIncidents: [],
      pausedAgentCount: 0,
      pausedProjectCount: 0,
      pendingApprovalCount: 0,
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  /** Draws the costs page, or with onPage false everything but it, as leaving the page does. */
  async function draw(onPage: boolean) {
    const client = (queryClient ??= new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    }));
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ToastProvider>
            {onPage ? <Costs /> : null}
            <ToastViewport />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
  }

  async function renderBudgets() {
    await draw(true);
    const budgetsTab = Array.from(container.querySelectorAll('[role="tab"]'))
      .find((tab) => tab.textContent?.trim() === "Budgets");
    expect(budgetsTab, "no Budgets tab").not.toBeUndefined();
    await act(async () => {
      budgetsTab!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });
    await vi.waitFor(() => {
      expect(card("Ada")).not.toBeNull();
      expect(card("Bo")).not.toBeNull();
    });
  }

  function card(name: string) {
    const title = Array.from(container.querySelectorAll('[data-slot="card-title"]'))
      .find((candidate) => candidate.textContent?.trim() === name);
    return (title?.closest('[data-slot="card"]') as HTMLElement | null) ?? null;
  }

  /** Types an amount into the card and presses its save button. */
  async function saveCard(name: string, dollars: string) {
    const input = card(name)!.querySelector("input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, dollars);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const button = Array.from(card(name)!.querySelectorAll("button"))
      .find((candidate) => candidate.textContent?.trim() === "Update budget");
    expect(button, `no save button on ${name}'s card`).not.toBeUndefined();
    await vi.waitFor(() => expect(button!.disabled).toBe(false));
    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
  }

  it("keeps a card's failure, naming whose budget it is, when another card then saves", async () => {
    mockBudgetsApi.upsertPolicy
      .mockRejectedValueOnce(new Error("Budgets are locked for this month."))
      .mockResolvedValueOnce(budget("agent-bo", "Bo"));
    await renderBudgets();
    const region = container.querySelector('aside[aria-live="polite"]') as HTMLElement;

    await saveCard("Ada", "75");
    await vi.waitFor(() => expect(region.textContent).toContain("Could not save the budget for Ada"));

    await saveCard("Bo", "90");
    await vi.waitFor(() => expect(region.textContent).toContain("Budget saved"));

    // Bo's save used to take back Ada's failure, while Ada's card still
    // showed the 75 that never went through.
    expect(region.textContent).toContain("Could not save the budget for Ada");
    expect(region.textContent).toContain("Budgets are locked for this month.");
    expect(card("Ada")!.querySelector("input")!.value).toBe("75");
    expect(mockBudgetsApi.upsertPolicy).toHaveBeenLastCalledWith(
      "company-1",
      expect.not.objectContaining({ scopeName: expect.anything() }),
    );
  });

  it("takes back a card's failure said before the page was left once that card saves", async () => {
    mockBudgetsApi.upsertPolicy
      .mockRejectedValueOnce(new Error("Budgets are locked for this month."))
      .mockResolvedValueOnce(budget("agent-ada", "Ada"));
    await renderBudgets();
    const region = container.querySelector('aside[aria-live="polite"]') as HTMLElement;

    await saveCard("Ada", "75");
    await vi.waitFor(() => expect(region.textContent).toContain("Could not save the budget for Ada"));

    // Off to another page and back, and Ada's card is saved again.
    await draw(false);
    await renderBudgets();
    await saveCard("Ada", "75");
    await vi.waitFor(() => expect(region.textContent).toContain("Budget saved"));

    // It used to stay up beside "Budget saved", as if Ada's budget had not
    // saved.
    expect(region.textContent).not.toContain("Could not save the budget for Ada");
  });
});
