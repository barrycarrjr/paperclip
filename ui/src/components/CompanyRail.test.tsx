// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyRail } from "./CompanyRail";
import { TooltipProvider } from "./ui/tooltip";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type TestCompany = {
  id: string;
  name: string;
  issuePrefix: string;
  isPortfolioRoot: boolean;
  kind: "standard" | "personal";
  status: "active" | "archived";
  logoUrl: string | null;
  brandColor: string | null;
};

const HQ: TestCompany = {
  id: "company-hq",
  name: "HQ",
  issuePrefix: "HQ",
  isPortfolioRoot: true,
  kind: "standard",
  status: "active",
  logoUrl: null,
  brandColor: null,
};

const ACME: TestCompany = {
  id: "company-acme",
  name: "Acme Printing",
  issuePrefix: "ACM",
  isPortfolioRoot: false,
  kind: "standard",
  status: "active",
  logoUrl: null,
  brandColor: null,
};

const navigateSpy = vi.hoisted(() => vi.fn());
const selectCompanySpy = vi.hoisted(() => vi.fn());
const railState = vi.hoisted(() => ({
  pathname: "/ACM/costs",
  companies: [] as unknown[],
  selectedCompanyId: null as string | null,
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: railState.pathname, search: "", hash: "" }),
  useNavigate: () => navigateSpy,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: railState.companies,
    selectedCompanyId: railState.selectedCompanyId,
    setSelectedCompanyId: selectCompanySpy,
  }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ openOnboarding: vi.fn() }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false, sidebarOpen: true }),
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: { liveRunsForCompany: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../api/sidebarBadges", () => ({
  sidebarBadgesApi: { get: vi.fn().mockResolvedValue({ inbox: 0 }) },
}));

vi.mock("../api/auth", () => ({
  authApi: { getSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }) },
}));

// Ordering companies is its own hook with its own storage; the rail only
// needs the list back in some order for these tests.
vi.mock("../hooks/useCompanyOrder", () => ({
  useCompanyOrder: ({ companies }: { companies: unknown[] }) => ({
    orderedCompanies: companies,
    persistOrder: vi.fn(),
  }),
}));

// The hover peek draws a whole sidebar menu inside the rail. It is not what
// these tests are about and it pulls in most of the app.
vi.mock("./SidebarMenu", () => ({
  SidebarMenu: () => null,
}));

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("CompanyRail", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    railState.pathname = "/ACM/costs";
    railState.companies = [HQ, ACME];
    railState.selectedCompanyId = ACME.id;
    navigateSpy.mockClear();
    selectCompanySpy.mockClear();
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    container.remove();
    document.body.innerHTML = "";
  });

  async function render() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <CompanyRail />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  function portfolioButton(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>('button[aria-label="Portfolio"]');
  }

  /** The company avatars are links; HQ's is the one pointing at HQ. */
  function hqAvatar(): HTMLAnchorElement | null {
    return container.querySelector<HTMLAnchorElement>('a[href="/HQ/dashboard"]');
  }

  function click(el: Element) {
    act(() => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  }

  it("puts a Portfolio button on the rail above HQ", async () => {
    await render();
    const portfolio = portfolioButton();
    expect(portfolio, "expected a Portfolio button on the rail").not.toBeNull();
    expect(hqAvatar(), "expected HQ on the rail").not.toBeNull();
    // Node.DOCUMENT_POSITION_FOLLOWING: HQ comes after Portfolio.
    expect(portfolio!.compareDocumentPosition(hqAvatar()!) & 4).toBe(4);
  });

  it("opens the all company version of the page you were on", async () => {
    railState.pathname = "/ACM/costs";
    await render();
    click(portfolioButton()!);
    expect(selectCompanySpy).toHaveBeenCalledWith(HQ.id, { source: "shortcut" });
    expect(navigateSpy).toHaveBeenCalledWith("/HQ/portfolio-costs");
  });

  it("falls back to the Portfolio Overview from a page with no all company version", async () => {
    railState.pathname = "/ACM/memories";
    await render();
    click(portfolioButton()!);
    expect(navigateSpy).toHaveBeenCalledWith("/HQ/portfolio-brief");
  });

  it("shows Portfolio as the one you are in, and does not also light HQ", async () => {
    // The two share an address prefix, so HQ is the selected company while a
    // portfolio page is open. Lighting both would say you are in two places.
    railState.pathname = "/HQ/portfolio-costs";
    railState.selectedCompanyId = HQ.id;
    await render();
    expect(portfolioButton()!.getAttribute("aria-pressed")).toBe("true");
    const hqPill = container.querySelector('a[href="/HQ/dashboard"] div');
    expect(hqPill?.className).toContain("h-0");
  });

  it("comes back to HQ's own version of the page when you click HQ from a portfolio page", async () => {
    railState.pathname = "/HQ/portfolio-costs";
    railState.selectedCompanyId = HQ.id;
    await render();
    click(container.querySelector('a[href="/HQ/dashboard"]')!);
    expect(navigateSpy).toHaveBeenCalledWith("/HQ/costs");
  });

  it("hides the Portfolio button from somebody who can only reach one company", async () => {
    railState.companies = [HQ];
    railState.selectedCompanyId = HQ.id;
    railState.pathname = "/HQ/brief";
    await render();
    expect(portfolioButton()).toBeNull();
    // HQ itself is still there; only the Portfolio button is withheld.
    expect(hqAvatar()).not.toBeNull();
  });

  it("hides the Portfolio button when there is no HQ to hang it under", async () => {
    railState.companies = [ACME];
    railState.selectedCompanyId = ACME.id;
    await render();
    expect(portfolioButton()).toBeNull();
  });
});
