// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionRow as AttentionRowData, DashboardSummary } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MorningBrief } from "./MorningBrief";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ companies: [{ id: "company-1" }] }),
}));
vi.mock("../hooks/useRouteCompany", () => ({
  useActiveCompanyId: () => "company-1",
}));
vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ openOnboarding: vi.fn() }),
}));
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));
vi.mock("../hooks/useEmailToolsPlugin", () => ({
  useEmailToolsPlugin: () => ({ pluginId: state.emailPluginId }),
}));
vi.mock("../api/emailTools", () => ({
  makeEmailToolsApi: () => state.emailApi,
}));
vi.mock("../hooks/useAttentionRowActions", () => ({
  useAttentionRowActions: () => ({ snooze: vi.fn(), dismiss: vi.fn() }),
}));
// Panels with their own data are not what these tests are about.
vi.mock("../components/ActiveAgentsPanel", () => ({ ActiveAgentsPanel: () => null }));
vi.mock("../components/ActivityCharts", () => ({
  ChartCard: () => null,
  RunActivityChart: () => null,
  PriorityChart: () => null,
  IssueStatusChart: () => null,
  SuccessRateChart: () => null,
}));
vi.mock("@/plugins/slots", () => ({ PluginSlotOutlet: () => null }));
vi.mock("../components/AttentionRow", () => ({
  AttentionRow: ({ row }: { row: AttentionRowData }) => <div>{row.title}</div>,
}));

const state: {
  summary: DashboardSummary;
  rows: AttentionRowData[];
  /** Rows that have gone quiet, only returned when asked for. */
  setAsideRows: AttentionRowData[];
  agents: Array<{ id: string; name: string; urlKey: string; status: string }>;
  /** No email-tools plugin unless a test installs one. */
  emailPluginId: string | null;
  emailApi: Record<string, unknown> | null;
  /** Issues the page lists to learn which mailboxes are triaged. */
  rulesHomeIssues: Array<{ id: string; title: string }>;
} = {
  summary: summary(),
  rows: [],
  setAsideRows: [],
  agents: [],
  emailPluginId: null,
  emailApi: null,
  rulesHomeIssues: [],
};

vi.mock("../api/auth", () => ({
  authApi: { getSession: async () => ({ user: { id: "user-1", name: "Barry Carr" } }) },
}));
vi.mock("../api/dashboard", () => ({
  dashboardApi: { summary: async () => state.summary },
}));
/** The company's activity; none unless a test adds some. */
const mockActivity = { events: [] as Array<Record<string, unknown>> };

vi.mock("../api/activity", () => ({ activityApi: { list: async () => mockActivity.events } }));
vi.mock("../api/attention", () => ({
  attentionApi: {
    // Like the server: set-aside rows are counted either way, and only listed
    // when asked for.
    list: async (_companyId: string, includeSetAside = false) => ({
      rows: includeSetAside ? [...state.rows, ...state.setAsideRows] : state.rows,
      count: state.rows.length,
      setAside: state.setAsideRows.length,
    }),
  },
}));
vi.mock("../api/issues", () => ({
  issuesApi: {
    list: async (_companyId: string, filters?: { q?: string }) => (filters?.q ? state.rulesHomeIssues : []),
  },
}));
vi.mock("../api/agents", () => ({ agentsApi: { list: async () => state.agents } }));
vi.mock("../api/access", () => ({ accessApi: { listUserDirectory: async () => ({ users: [] }) } }));

function summary(
  overrides: {
    agentErrors?: number;
    blocked?: number;
    pendingApprovals?: number;
    budgetApprovals?: number;
    incidents?: number;
  } = {},
): DashboardSummary {
  return {
    companyId: "company-1",
    agents: { active: 2, running: 0, paused: 0, error: overrides.agentErrors ?? 0 },
    tasks: { open: 3, inProgress: 1, blocked: overrides.blocked ?? 0, done: 5 },
    costs: { monthSpendCents: 0, monthBudgetCents: 0, monthUtilizationPercent: 0 },
    pendingApprovals: overrides.pendingApprovals ?? 0,
    budgets: {
      activeIncidents: overrides.incidents ?? 0,
      pendingApprovals: overrides.budgetApprovals ?? 0,
      pausedAgents: 0,
      pausedProjects: 0,
    },
    runActivity: [],
  };
}

function attentionRow(key: string): AttentionRowData {
  return {
    key,
    kind: "question",
    companyId: "company-1",
    title: `Question ${key}`,
    detail: null,
    askedBy: null,
    blocking: "waiting",
    blockedSinceMs: null,
    count: 1,
    consequence: null,
    deadlineAtMs: null,
    deadlineOutcome: null,
    href: "/issues/PER-1",
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("MorningBrief", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    state.summary = summary();
    state.rows = [];
    state.setAsideRows = [];
    state.agents = [];
    state.emailPluginId = null;
    state.emailApi = null;
    state.rulesHomeIssues = [];
    mockActivity.events = [];
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function settle() {
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  async function renderPage() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <MorningBrief />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    // Let every query settle so the page is past its skeleton.
    await settle();
  }

  function heroText(): string {
    return container.querySelector('section[aria-label="Morning brief"]')?.textContent ?? "";
  }

  function link(label: RegExp): HTMLAnchorElement | undefined {
    return Array.from(container.querySelectorAll("a")).find((a) => label.test(a.textContent ?? ""));
  }

  // Seen live: "All systems green." over nine blocked tasks and a full
  // Attention list, and "1 agent error." beside a green dot with no name.
  it("says what is wrong, names the agent in error and links to it", async () => {
    state.summary = summary({ agentErrors: 1, blocked: 9 });
    state.rows = [attentionRow("question:1"), attentionRow("question:2")];
    state.agents = [
      { id: "agent-1", name: "Scout", urlKey: "scout", status: "error" },
      { id: "agent-2", name: "Writer", urlKey: "writer", status: "idle" },
    ];
    await renderPage();

    expect(heroText()).toContain("1 agent in error (Scout), 9 tasks blocked, 2 waiting on you.");
    expect(heroText()).not.toContain("All systems green.");
    expect(link(/^Scout$/)?.getAttribute("href")).toBe("/agents/scout");
    expect(container.querySelector('[data-tone="red"]')).not.toBeNull();
  });

  it("links to the full Attention list with its count", async () => {
    state.rows = [attentionRow("question:1"), attentionRow("question:2")];
    await renderPage();

    const seeAll = link(/^See all in Attention/);
    expect(seeAll?.textContent).toBe("See all in Attention (2)");
    expect(seeAll?.getAttribute("href")).toBe("/inbox");
    expect(container.querySelector('[data-tone="amber"]')).not.toBeNull();
  });

  // Rows that have gone quiet are not waiting on anyone, so showing them must
  // not raise the headline or the link's count above the badge's number.
  it("leaves gone-quiet rows out of the counts while they are shown", async () => {
    state.rows = [attentionRow("question:1"), attentionRow("question:2")];
    state.setAsideRows = [attentionRow("failure:1"), attentionRow("failure:2")];
    await renderPage();

    const showThem = Array.from(container.querySelectorAll("button")).find((button) =>
      /show them/.test(button.textContent ?? ""),
    );
    expect(showThem).toBeDefined();
    await act(async () => {
      showThem!.click();
    });
    await settle();

    expect(container.textContent).toContain("Question failure:1");
    expect(link(/^See all in Attention/)?.textContent).toBe("See all in Attention (2)");
    expect(heroText()).toContain("2 waiting on you.");
    expect(heroText()).not.toContain("4 waiting on you");
  });

  // A hard stop makes one budget override approval. The summary's approval
  // count already holds it, so the headline must not add the budget count too.
  it("names a pending budget override once", async () => {
    state.summary = summary({ incidents: 1, pendingApprovals: 1, budgetApprovals: 1 });
    await renderPage();

    expect(heroText()).toContain("1 budget incident, 1 approval pending.");
    expect(heroText()).not.toContain("2 approvals");
    expect(container.querySelector('[data-tone="amber"]')).not.toBeNull();
  });

  it("says outcome, not outcomes, for a single overnight outcome", async () => {
    mockActivity.events = [
      {
        id: "event-1",
        companyId: "company-1",
        actorType: "user",
        actorId: "user-1",
        action: "issue.created",
        entityType: "issue",
        entityId: "issue-9",
        agentId: null,
        runId: null,
        details: { title: "Reprint the banner" },
        createdAt: new Date().toISOString(),
      },
    ];
    await renderPage();

    expect(heroText()).toContain("1 outcome overnight");
    expect(heroText()).not.toContain("1 outcomes");
  });

  it("stays green, and still offers the Attention link, when nothing is wrong", async () => {
    await renderPage();

    expect(heroText()).toContain("All systems green.");
    expect(container.querySelector('[data-tone="green"]')).not.toBeNull();
    expect(link(/^See all in Attention/)?.textContent).toBe("See all in Attention");
    expect(container.textContent).toContain("Nothing waiting on you.");
  });

  function installEmail(dismissReviewEntry: () => Promise<unknown>) {
    const api = {
      listMessages: vi.fn(async () => ({
        messages: [
          {
            uid: 7,
            from: "Shop Example <promo@shop.example.com>",
            subject: "Autumn sale",
            date: "2026-10-09T08:00:00.000Z",
          },
        ],
        uidValidity: 1,
      })),
      listRules: vi.fn(async () => ({ rules: [] })),
      fetchMessage: vi.fn(async () => ({ text: "" })),
      markRead: vi.fn(async () => ({ ok: true })),
      setRule: vi.fn(async () => ({ ok: true })),
      dismissReviewEntry: vi.fn(dismissReviewEntry),
    };
    state.emailPluginId = "email-plugin";
    state.emailApi = api;
    state.rulesHomeIssues = [{ id: "issue-1", title: "Email triage rules - personal" }];
    return api;
  }

  async function clickDismiss() {
    const dismiss = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Dismiss",
    );
    expect(dismiss).toBeDefined();
    await act(async () => {
      dismiss!.click();
    });
    await settle();
  }

  // The triage routine keeps its own review queue in email-tools. Dismissing a
  // sender here only marked the mail read, so the routine kept reporting a
  // sender the operator had already dealt with.
  it("Dismiss on an email sender also clears it from the triage review queue", async () => {
    const api = installEmail(async () => ({ ok: true, cleared: 1 }));
    await renderPage();
    await clickDismiss();

    expect(api.markRead).toHaveBeenCalledWith("personal", 7, "INBOX");
    expect(api.dismissReviewEntry).toHaveBeenCalledWith("personal", "promo@shop.example.com");
    expect(api.setRule).not.toHaveBeenCalled();
  });

  it("says so when the review queue entry could not be cleared", async () => {
    installEmail(async () => Promise.reject(new Error("Review queue unavailable")));
    await renderPage();
    await clickDismiss();

    expect(container.textContent).toContain("Review queue unavailable");
  });
});
