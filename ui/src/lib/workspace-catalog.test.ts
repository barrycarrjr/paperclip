import { describe, expect, it } from "vitest";
import {
  CORE_WORKSPACE_CATALOG,
  isWorkspaceAvailable,
  visibleWorkspaceCatalog,
  workspaceCatalogEntryForRouteRoot,
  workspaceUnavailableReason,
  resolvePinnedWorkspaceItems,
} from "./workspace-catalog";
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

describe("workspace availability", () => {
  const gated = CORE_WORKSPACE_CATALOG.find((entry) => entry.id === "workspaces")!;
  const ungated = CORE_WORKSPACE_CATALOG.find((entry) => entry.id === "issues")!;

  it("leaves workspaces without a requirement always available", () => {
    expect(ungated.requires).toBeUndefined();
    expect(isWorkspaceAvailable(ungated, undefined)).toBe(true);
    expect(isWorkspaceAvailable(ungated, null)).toBe(true);
    expect(isWorkspaceAvailable(ungated, { isolatedWorkspacesEnabled: false })).toBe(true);
  });

  it("gates Workspaces on the isolated-workspaces switch", () => {
    expect(isWorkspaceAvailable(gated, { isolatedWorkspacesEnabled: true })).toBe(true);
    expect(isWorkspaceAvailable(gated, { isolatedWorkspacesEnabled: false })).toBe(false);
  });

  it("treats an unknown answer as unavailable rather than available", () => {
    // The settings query is still in flight on a cold load. Briefly not
    // offering a destination corrects itself; briefly offering one that turns
    // out to be off sends someone to a page that cannot help them.
    expect(isWorkspaceAvailable(gated, undefined)).toBe(false);
    expect(isWorkspaceAvailable(gated, null)).toBe(false);
    expect(isWorkspaceAvailable(gated, {})).toBe(false);
  });

  it("explains why, in a sentence, only when it is unavailable", () => {
    expect(workspaceUnavailableReason(gated, { isolatedWorkspacesEnabled: true })).toBeNull();
    expect(workspaceUnavailableReason(gated, { isolatedWorkspacesEnabled: false })).toContain(
      "switched off",
    );
    expect(workspaceUnavailableReason(ungated, { isolatedWorkspacesEnabled: false })).toBeNull();
  });

  it("drops gated entries from the visible list when the switch is off", () => {
    const off = visibleWorkspaceCatalog({
      isPortfolioRoot: true,
      availability: { isolatedWorkspacesEnabled: false },
    });
    const on = visibleWorkspaceCatalog({
      isPortfolioRoot: true,
      availability: { isolatedWorkspacesEnabled: true },
    });

    expect(off.some((e) => e.id === "workspaces")).toBe(false);
    expect(on.some((e) => e.id === "workspaces")).toBe(true);
    // Nothing else moves.
    expect(on.length - off.length).toBe(1);
  });

  it("keeps every entry when availability is not supplied at all", () => {
    // Existing callers that never passed availability must not silently lose
    // destinations they used to list.
    const withoutAvailability = visibleWorkspaceCatalog({ isPortfolioRoot: true });
    expect(withoutAvailability.some((e) => e.id === "workspaces")).toBe(true);
    expect(withoutAvailability).toHaveLength(CORE_WORKSPACE_CATALOG.length);
  });

  it("still hides portfolio-only entries outside HQ", () => {
    const entries = visibleWorkspaceCatalog({
      isPortfolioRoot: false,
      availability: { isolatedWorkspacesEnabled: true },
    });
    expect(entries.some((e) => e.portfolioRootOnly)).toBe(false);
  });
});

describe("workspaceCatalogEntryForRouteRoot", () => {
  it("finds an entry from a path segment, however it is written", () => {
    expect(workspaceCatalogEntryForRouteRoot("issues")?.id).toBe("issues");
    expect(workspaceCatalogEntryForRouteRoot("/issues")?.id).toBe("issues");
    expect(workspaceCatalogEntryForRouteRoot("/issues/PAP-1")?.id).toBe("issues");
    expect(workspaceCatalogEntryForRouteRoot("ISSUES")?.id).toBe("issues");
  });

  it("returns nothing for anything that is not a core workspace", () => {
    expect(workspaceCatalogEntryForRouteRoot("plugins")).toBeNull();
    expect(workspaceCatalogEntryForRouteRoot("")).toBeNull();
    expect(workspaceCatalogEntryForRouteRoot("/")).toBeNull();
  });
});

describe("resolvePinnedWorkspaceItems", () => {
  const noPlugins: { routePath: string | null; displayName: string }[] = [];
  const available = { isolatedWorkspacesEnabled: true };

  it("returns nothing when nothing is pinned", () => {
    expect(
      resolvePinnedWorkspaceItems({
        pinned: [],
        isPortfolioRoot: true,
        availability: available,
        pluginSlots: noPlugins,
      }),
    ).toEqual([]);
  });

  it("keeps the person's own order, not the catalog's", () => {
    const items = resolvePinnedWorkspaceItems({
      pinned: ["goals", "email", "issues"],
      isPortfolioRoot: false,
      availability: available,
      pluginSlots: noPlugins,
    });
    expect(items.map((i) => i.id)).toEqual(["goals", "email", "issues"]);
    expect(items.map((i) => i.to)).toEqual(["/goals", "/email", "/issues"]);
  });

  it("hides a portfolio page outside HQ without dropping the pin", () => {
    const args = {
      pinned: ["portfolio-brief", "issues"],
      availability: available,
      pluginSlots: noPlugins,
    };
    expect(
      resolvePinnedWorkspaceItems({ ...args, isPortfolioRoot: false }).map((i) => i.id),
    ).toEqual(["issues"]);
    // The same saved list still shows it at HQ, which is why hiding rather
    // than un-pinning is the right behaviour.
    expect(
      resolvePinnedWorkspaceItems({ ...args, isPortfolioRoot: true }).map((i) => i.id),
    ).toEqual(["portfolio-brief", "issues"]);
  });

  it("hides a pinned workspace whose requirement is not met", () => {
    const items = resolvePinnedWorkspaceItems({
      pinned: ["workspaces", "issues"],
      isPortfolioRoot: false,
      availability: { isolatedWorkspacesEnabled: false },
      pluginSlots: noPlugins,
    });
    expect(items.map((i) => i.id)).toEqual(["issues"]);
  });

  it("resolves a pinned plugin page by its route path", () => {
    const items = resolvePinnedWorkspaceItems({
      pinned: ["notepad"],
      isPortfolioRoot: false,
      availability: available,
      pluginSlots: [{ routePath: "notepad", displayName: "Notepad" }],
    });
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe("Notepad");
    expect(items[0].to).toBe("/notepad");
  });

  it("skips a pinned plugin this company does not have", () => {
    // Pins are per person and asked about in every company, so a plugin that
    // is not installed here is simply not shown here.
    const items = resolvePinnedWorkspaceItems({
      pinned: ["notepad", "issues"],
      isPortfolioRoot: false,
      availability: available,
      pluginSlots: noPlugins,
    });
    expect(items.map((i) => i.id)).toEqual(["issues"]);
  });

  it("skips an id that means nothing rather than rendering a dead link", () => {
    const items = resolvePinnedWorkspaceItems({
      pinned: ["a-plugin-that-was-removed", "issues"],
      isPortfolioRoot: false,
      availability: available,
      pluginSlots: noPlugins,
    });
    expect(items.map((i) => i.id)).toEqual(["issues"]);
  });

  it("does not render the same pin twice", () => {
    const items = resolvePinnedWorkspaceItems({
      pinned: ["issues", "issues"],
      isPortfolioRoot: false,
      availability: available,
      pluginSlots: noPlugins,
    });
    expect(items).toHaveLength(1);
  });
});
