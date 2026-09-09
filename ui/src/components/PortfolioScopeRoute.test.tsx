import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PortfolioScopeRoute } from "./PortfolioScopeRoute";

const state = vi.hoisted(() => ({
  pathname: "/ACME/portfolio-costs",
  activeCompanyId: "acme" as string | null,
  loading: false,
  companies: [
    { id: "hq", name: "HQ", issuePrefix: "HQ", isPortfolioRoot: true, status: "active" },
    { id: "acme", name: "Acme", issuePrefix: "ACME", isPortfolioRoot: false, status: "active" },
  ],
}));

vi.mock("@/lib/router", () => ({
  Outlet: () => <div>The portfolio page</div>,
  useLocation: () => ({ pathname: state.pathname, search: "", hash: "", state: null }),
  Link: ({ children, to, ...props }: ComponentProps<"a"> & { to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ companies: state.companies, loading: state.loading }),
}));

vi.mock("../hooks/useRouteCompany", () => ({
  useActiveCompanyId: () => state.activeCompanyId,
  useIsActiveCompanyPortfolioRoot: () =>
    state.companies.find((c) => c.id === state.activeCompanyId)?.isPortfolioRoot ?? false,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

describe("PortfolioScopeRoute", () => {
  beforeEach(() => {
    state.pathname = "/ACME/portfolio-costs";
    state.activeCompanyId = "acme";
    state.loading = false;
  });

  it("opens the page when the address names HQ", () => {
    state.pathname = "/HQ/portfolio-costs";
    state.activeCompanyId = "hq";
    expect(renderToStaticMarkup(<PortfolioScopeRoute />)).toContain("The portfolio page");
  });

  it("says the page is not available in an ordinary company, instead of drawing nothing", () => {
    const html = renderToStaticMarkup(<PortfolioScopeRoute />);
    expect(html).not.toContain("The portfolio page");
    expect(html).toContain("Portfolio Costs is not available here");
    expect(html).toContain("Acme is one company, and this page adds every company together.");
  });

  it("offers that company's own version of the page", () => {
    const html = renderToStaticMarkup(<PortfolioScopeRoute />);
    expect(html).toContain("/ACME/costs");
    expect(html).toContain("Open Acme&#x27;s Costs");
  });

  it("offers the Overview when the page has no per company version", () => {
    state.pathname = "/ACME/portfolio-directives";
    const html = renderToStaticMarkup(<PortfolioScopeRoute />);
    expect(html).toContain("Portfolio Directives is not available here");
    expect(html).toContain("/ACME/brief");
  });

  it("says where the all company pages live", () => {
    expect(renderToStaticMarkup(<PortfolioScopeRoute />)).toContain(
      "The all company pages live in HQ.",
    );
  });

  it("waits for the company list rather than accusing HQ of the wrong scope", () => {
    state.loading = true;
    state.activeCompanyId = null;
    expect(renderToStaticMarkup(<PortfolioScopeRoute />)).toContain("The portfolio page");
  });
});
