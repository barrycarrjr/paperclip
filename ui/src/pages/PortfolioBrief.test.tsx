// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PortfolioBrief } from "./PortfolioBrief";

const HQ = { id: "hq", name: "HQ", issuePrefix: "HQ", isPortfolioRoot: true, status: "active" };
const PRINT_CO = {
  id: "company-1",
  name: "Example Print Co",
  issuePrefix: "EXP",
  isPortfolioRoot: false,
  status: "active",
};

const state: { emailApi: Record<string, unknown> | null } = { emailApi: null };

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: HQ,
    selectedCompanyId: HQ.id,
    setSelectedCompanyId: vi.fn(),
    companies: [HQ, PRINT_CO],
  }),
}));
vi.mock("../hooks/useRouteCompany", () => ({
  useActiveCompanyId: () => HQ.id,
  useIsActiveCompanyPortfolioRoot: () => true,
}));
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));
vi.mock("../hooks/useEmailToolsPlugin", () => ({
  useEmailToolsPlugin: () => ({ pluginId: "email-plugin" }),
}));
vi.mock("../api/emailTools", () => ({
  makeEmailToolsApi: () => state.emailApi,
}));
vi.mock("../api/plugins", () => ({
  pluginsApi: {
    getConfig: async () => ({
      configJson: { mailboxes: [{ key: "personal", allowedCompanies: [PRINT_CO.id] }] },
    }),
    bridgePerformAction: vi.fn(),
  },
}));
vi.mock("../hooks/useAttentionRowActions", () => ({
  useAttentionRowActions: () => ({ snooze: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("../hooks/useCompanyOrder", () => ({
  useCompanyOrder: ({ companies }: { companies: unknown[] }) => ({ orderedCompanies: companies }),
}));
// Sections with their own data are not what these tests are about.
vi.mock("../components/SortableSections", () => ({
  SortableSections: ({ sections }: { sections: Array<{ id: string; render: () => ReactNode }> }) => (
    <>
      {sections.map((section) => (
        <div key={section.id}>{section.render()}</div>
      ))}
    </>
  ),
}));
vi.mock("../components/ActiveAgentsPanel", () => ({
  AgentRunCard: () => null,
  SleepingAgentsStrip: () => null,
  isRunActive: () => false,
  DASHBOARD_AGENT_RUN_CONFIG: { maxChunksPerRun: 1, logPollIntervalMs: 60_000, logReadLimitBytes: 1024 },
}));
vi.mock("../components/GroupedRunsCard", () => ({
  GroupedRunsCard: () => null,
  groupRunsByIssue: () => [],
}));
vi.mock("../components/transcript/useLiveRunTranscripts", () => ({
  useLiveRunTranscripts: () => ({ transcriptByRun: new Map(), hasOutputForRun: () => false }),
}));
vi.mock("../components/CompanyPatternIcon", () => ({ CompanyPatternIcon: () => null }));
vi.mock("../api/auth", () => ({
  authApi: { getSession: async () => ({ user: { id: "user-1", name: "Pat Example" } }) },
}));
vi.mock("../api/dashboard", () => ({
  dashboardApi: { listPortfolio: async () => ({ companies: [PRINT_CO], summaries: [] }) },
}));
vi.mock("../api/activity", () => ({
  activityApi: { listPortfolio: async () => ({ events: [], companies: [] }) },
}));
vi.mock("../api/attention", () => ({
  attentionApi: { listPortfolio: async () => ({ rows: [], count: 0, setAside: 0, companies: [] }) },
}));
vi.mock("../api/issues", () => ({
  issuesApi: {
    // The rules-home title search is how the page learns which mailboxes to read.
    listPortfolio: async (_companyId: string, filters?: { q?: string }) =>
      filters?.q
        ? {
            issues: [{ id: "issue-1", companyId: PRINT_CO.id, title: "Email triage rules - personal" }],
            companies: [PRINT_CO],
          }
        : { issues: [], companies: [] },
    list: async () => [],
  },
}));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: { liveRunsForCompany: async () => [] } }));
vi.mock("../api/agents", () => ({ agentsApi: { listPortfolio: async () => ({ agents: [] }) } }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function emailApi(dismissReviewEntry: () => Promise<unknown>) {
  return {
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
    dismissReviewEntry: vi.fn(dismissReviewEntry),
  };
}

describe("PortfolioBrief", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    state.emailApi = null;
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
            <PortfolioBrief />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await settle();
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

  it("Dismiss on an email sender marks its mail read and clears it from the triage review queue", async () => {
    const api = emailApi(async () => ({ ok: true, cleared: 1 }));
    state.emailApi = api;
    await renderPage();
    await clickDismiss();

    expect(api.markRead).toHaveBeenCalledWith("personal", 7, "INBOX");
    expect(api.dismissReviewEntry).toHaveBeenCalledWith("personal", "promo@shop.example.com");
  });

  it("says so when the review queue entry could not be cleared", async () => {
    state.emailApi = emailApi(async () => Promise.reject(new Error("Review queue unavailable")));
    await renderPage();
    await clickDismiss();

    expect(container.textContent).toContain("Review queue unavailable");
  });

  it("still dismisses quietly on an email-tools that has no review queue", async () => {
    state.emailApi = emailApi(async () =>
      Promise.reject(new Error('No action handler registered for key "email.dismiss-review-entry"')),
    );
    await renderPage();
    await clickDismiss();

    expect(container.textContent).not.toContain("No action handler");
  });
});
