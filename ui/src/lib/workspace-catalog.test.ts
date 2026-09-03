import { describe, expect, it } from "vitest";
import { CORE_WORKSPACE_CATALOG, visibleWorkspaceCatalog } from "./workspace-catalog";
import { isBoardPathWithoutPrefix } from "./company-routes";

describe("CORE_WORKSPACE_CATALOG", () => {
  it("has a unique id and a unique routeRoot per entry", () => {
    const ids = CORE_WORKSPACE_CATALOG.map((e) => e.id);
    const roots = CORE_WORKSPACE_CATALOG.map((e) => e.routeRoot);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(roots).size).toBe(roots.length);
  });

  it("every routeRoot is a real registered board route", () => {
    // Regression guard for the exact drift this catalog exists to avoid
    // repeating: every entry here must be a route company-routes.ts (and,
    // through it, App.tsx's boardRoutes()) actually knows about, or this
    // catalog would send someone to a route that gets treated as a company
    // prefix instead of a page.
    for (const entry of CORE_WORKSPACE_CATALOG) {
      expect(isBoardPathWithoutPrefix(`/${entry.routeRoot}`), entry.routeRoot).toBe(true);
    }
  });

  it("marks every portfolio-* entry as portfolio-root-only and nothing else", () => {
    for (const entry of CORE_WORKSPACE_CATALOG) {
      expect(entry.routeRoot.startsWith("portfolio-")).toBe(Boolean(entry.portfolioRootOnly));
    }
  });
});

describe("visibleWorkspaceCatalog", () => {
  it("hides portfolio-only entries for a non-portfolio-root company", () => {
    const visible = visibleWorkspaceCatalog({ isPortfolioRoot: false });
    expect(visible.some((e) => e.portfolioRootOnly)).toBe(false);
    expect(visible.some((e) => e.id === "brief")).toBe(true);
  });

  it("includes portfolio entries for the portfolio-root company", () => {
    const visible = visibleWorkspaceCatalog({ isPortfolioRoot: true });
    expect(visible.some((e) => e.id === "portfolio-brief")).toBe(true);
    expect(visible.length).toBe(CORE_WORKSPACE_CATALOG.length);
  });
});
