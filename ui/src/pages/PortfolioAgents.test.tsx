// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PortfolioTeamsAgents,
  PortfolioTeamsAssistants,
  PortfolioTeamsRightNow,
} from "./PortfolioAgents";
import { TooltipProvider } from "@/components/ui/tooltip";

const listPortfolio = vi.fn();
const listOrg = vi.fn();
const liveRunsForCompany = vi.fn();
const setBreadcrumbs = vi.fn();

vi.mock("@/lib/router", () => ({
  CompanyRoutePrefixProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Link: ({
    to,
    children,
    className,
    ...props
  }: {
    to: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={to} className={className} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}));

vi.mock("../components/TeamCurrentWork", () => ({
  TeamCurrentWork: ({ companyId }: { companyId: string }) => (
    <div data-testid={`current-work-${companyId}`}>Current work for {companyId}</div>
  ),
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    listPortfolio: (...args: unknown[]) => listPortfolio(...args),
    org: (...args: unknown[]) => listOrg(...args),
    pause: vi.fn(),
    resume: vi.fn(),
  },
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: {
    liveRunsForCompany: (...args: unknown[]) => liveRunsForCompany(...args),
  },
}));

vi.mock("../hooks/useRouteCompany", () => ({
  useActiveCompanyId: () => "hq",
}));

vi.mock("../hooks/usePortfolioCompanyOptions", () => ({
  usePortfolioCompanyOptions: () => [
    { value: "hq", label: "HQ" },
    { value: "company-1", label: "Acme" },
  ],
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs }),
}));

vi.mock("../components/CompanyPatternIcon", () => ({
  CompanyPatternIcon: ({ companyName }: { companyName: string }) => (
    <span aria-hidden>{companyName.slice(0, 1)}</span>
  ),
}));

vi.mock("../components/LiveRunIndicator", () => ({
  LiveRunIndicator: () => <span>Live run</span>,
}));

vi.mock("../components/OrgTreeNode", () => ({
  OrgTreeNode: ({ node }: { node: { name: string } }) => <div>{node.name}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// The production types are intentionally larger than these view fixtures.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function company(overrides: Record<string, unknown>): any {
  return {
    id: "company-1",
    name: "Acme",
    issuePrefix: "ACM",
    isPortfolioRoot: false,
    status: "active",
    logoUrl: null,
    brandColor: null,
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function agent(overrides: Record<string, unknown>): any {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Operator",
    role: "general",
    title: null,
    status: "idle",
    pausedAt: null,
    lastHeartbeatAt: null,
    adapterType: "codex_local",
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

describe("PortfolioTeamsAgents", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    window.localStorage.clear();
    listPortfolio.mockReset();
    listOrg.mockReset();
    liveRunsForCompany.mockReset();
    setBreadcrumbs.mockReset();

    listPortfolio.mockResolvedValue({
      companies: [
        company({ id: "hq", name: "HQ", issuePrefix: "HQ", isPortfolioRoot: true }),
        company({ id: "company-1", name: "Acme", issuePrefix: "ACM" }),
      ],
      agents: [
        agent({ id: "hq-1", companyId: "hq", name: "Steward" }),
        agent({ id: "acme-1", companyId: "company-1", name: "Researcher" }),
        agent({ id: "acme-2", companyId: "company-1", name: "Writer", status: "error" }),
      ],
    });
    listOrg.mockResolvedValue([]);
    liveRunsForCompany.mockImplementation(async (companyId: string) =>
      companyId === "hq"
        ? [{ id: "run-1", agentId: "hq-1", status: "running" }]
        : [],
    );

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

  async function render(view: React.ReactNode = <PortfolioTeamsAgents />) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            {view}
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await settle();
  }

  it("makes companies the portfolio-level teams and nests their agents", async () => {
    await render();

    expect(container.textContent).toContain("Agents");
    expect(container.textContent).toContain("2 teams · 3 members");
    expect(container.textContent).toContain("Team · 1 member");
    expect(container.textContent).toContain("Team · 2 members");
    expect(container.textContent).toContain("Steward");
    expect(container.textContent).toContain("Researcher");
    expect(container.textContent).toContain("Writer");
    expect(container.textContent).toContain("1 live");
    expect(container.textContent).toContain("1 error");

    const teamLinks = Array.from(container.querySelectorAll("a"))
      .filter((link) => link.textContent?.includes("Open team"))
      .map((link) => link.getAttribute("href"));
    expect(teamLinks).toEqual(["/HQ/agents/all", "/ACM/agents/all"]);
  });

  it("keeps a team visible when its nested members are collapsed", async () => {
    await render();

    const acmeToggle = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.getAttribute("aria-expanded") === "true" && button.textContent?.includes("Acme"),
    );
    expect(acmeToggle).toBeDefined();

    await act(async () => {
      acmeToggle!.click();
    });

    expect(acmeToggle?.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).toContain("Acme");
    expect(container.textContent).not.toContain("Researcher");
    expect(container.textContent).not.toContain("Writer");
  });

  it("opens on a cross-company Right now view and lazily expands another team", async () => {
    await render(<PortfolioTeamsRightNow />);

    expect(container.querySelector('[data-testid="current-work-hq"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="current-work-company-1"]')).toBeNull();

    const teamLinks = Array.from(container.querySelectorAll("a"))
      .filter((link) => link.textContent?.includes("Open team"))
      .map((link) => link.getAttribute("href"));
    expect(teamLinks).toEqual(["/HQ/team", "/ACM/team"]);

    const acmeToggle = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) =>
        button.getAttribute("aria-expanded") === "false" && button.textContent?.includes("Acme"),
    );
    expect(acmeToggle).toBeDefined();
    await act(async () => acmeToggle!.click());
    expect(container.querySelector('[data-testid="current-work-company-1"]')).not.toBeNull();
  });

  it("groups assistants by their owning team and links to each company's assistant view", async () => {
    listPortfolio.mockResolvedValueOnce({
      companies: [
        company({ id: "hq", name: "HQ", issuePrefix: "HQ", isPortfolioRoot: true }),
        company({ id: "company-1", name: "Acme", issuePrefix: "ACM" }),
      ],
      agents: [
        agent({ id: "hq-1", companyId: "hq", name: "Steward" }),
        agent({ id: "assistant-1", companyId: "company-1", name: "Concierge", role: "assistant" }),
      ],
    });

    await render(<PortfolioTeamsAssistants />);

    expect(container.textContent).toContain("1 assistant across 2 teams");
    expect(container.textContent).toContain("Concierge");
    const teamLinks = Array.from(container.querySelectorAll("a"))
      .filter((link) => link.textContent?.includes("Open team"))
      .map((link) => link.getAttribute("href"));
    expect(teamLinks).toEqual(["/HQ/assistants", "/ACM/assistants"]);
  });
});
