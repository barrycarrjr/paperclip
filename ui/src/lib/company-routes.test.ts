import { afterEach, describe, expect, it } from "vitest";
import {
  applyCompanyPrefix,
  extractCompanyPrefixFromPath,
  isBoardPathWithoutPrefix,
  toCompanyRelativePath,
} from "./company-routes";
import {
  _resetPluginRouteRegistryForTests,
  registerPluginRouteRoots,
} from "./plugin-route-registry";

describe("company routes", () => {
  it("treats execution workspace paths as board routes that need a company prefix", () => {
    expect(isBoardPathWithoutPrefix("/execution-workspaces/workspace-123")).toBe(true);
    expect(extractCompanyPrefixFromPath("/execution-workspaces/workspace-123")).toBeNull();
    expect(applyCompanyPrefix("/execution-workspaces/workspace-123", "PAP")).toBe(
      "/PAP/execution-workspaces/workspace-123",
    );
  });

  it("normalizes prefixed execution workspace paths back to company-relative paths", () => {
    expect(toCompanyRelativePath("/PAP/execution-workspaces/workspace-123")).toBe(
      "/execution-workspaces/workspace-123",
    );
  });

  it("treats /portfolio-directives as a board page, not a company prefix", () => {
    // Regression: missing from BOARD_ROUTE_ROOTS made the HQ nav link resolve
    // to /portfolio-directives (unprefixed), which the company gate then read
    // as a company slug → "Company not found".
    expect(isBoardPathWithoutPrefix("/portfolio-directives")).toBe(true);
    expect(extractCompanyPrefixFromPath("/portfolio-directives")).toBeNull();
    expect(applyCompanyPrefix("/portfolio-directives", "HQ")).toBe("/HQ/portfolio-directives");
  });

  it("treats /portfolio-calendar and /calendar as board pages, not company prefixes", () => {
    // Regression: the calendar/event feature added the routes and nav but not
    // the BOARD_ROUTE_ROOTS entries, so the company gate read the paths as
    // company slugs → "Company not found" (same failure as portfolio-directives).
    expect(isBoardPathWithoutPrefix("/portfolio-calendar")).toBe(true);
    expect(extractCompanyPrefixFromPath("/portfolio-calendar")).toBeNull();
    expect(applyCompanyPrefix("/portfolio-calendar", "HQ")).toBe("/HQ/portfolio-calendar");
    expect(isBoardPathWithoutPrefix("/calendar")).toBe(true);
    expect(extractCompanyPrefixFromPath("/calendar")).toBeNull();
    expect(applyCompanyPrefix("/calendar", "HQ")).toBe("/HQ/calendar");
  });

  it("does not mistake the /clippy-popup pop-out route for a company slug", () => {
    expect(extractCompanyPrefixFromPath("/clippy-popup")).toBeNull();
    // Once Link/NavLink resolution sees no active prefix in the URL, it must
    // not prepend "CLIPPY-POPUP" to issue links rendered inside the popup.
    expect(applyCompanyPrefix("/issues/IND-44", null)).toBe("/issues/IND-44");
  });

  it("strips the company prefix from a full Clippy workspace path (B01)", () => {
    // Regression for docs/plans/2026-09-02-ux-control-center-preservation.md
    // B01: "clippy" was missing from GLOBAL_ROUTE_ROOTS even though its
    // pop-out sibling "clippy-popup" was present. toCompanyRelativePath's
    // second-segment check never matched "clippy" either (it isn't a
    // BOARD_ROUTE_ROOTS entry), so a remembered "/IND/clippy" path was stored
    // un-stripped by useCompanyPageMemory and then replayed with a second
    // prefix on the next company switch: "/IND/IND/clippy".
    expect(extractCompanyPrefixFromPath("/clippy")).toBeNull();
    expect(toCompanyRelativePath("/IND/clippy")).toBe("/clippy");
  });

  it("treats onboarding/settings/plugins/assistants as board pages (B01 follow-on)", () => {
    // BOARD_ROUTE_ROOTS now comes from the shared
    // PLUGIN_RESERVED_COMPANY_ROUTE_SEGMENTS constant (see company-routes.ts's
    // top comment) instead of an independently hand-maintained list. Before
    // that unification these four were missing here even though App.tsx's
    // boardRoutes() has always registered them — same double-prefix failure
    // mode as clippy above, just never reported because none of them happen
    // to be common company-switch destinations. Cross-checked against a full
    // line-by-line read of boardRoutes() on 2026-09-02, not just spot-checked.
    for (const root of ["onboarding", "settings", "plugins", "assistants"]) {
      expect(isBoardPathWithoutPrefix(`/${root}`)).toBe(true);
      expect(extractCompanyPrefixFromPath(`/${root}`)).toBeNull();
      expect(toCompanyRelativePath(`/PAP/${root}`)).toBe(`/${root}`);
    }
  });

  describe("plugin-contributed routes (B01, fixed via the runtime registry)", () => {
    afterEach(() => {
      _resetPluginRouteRegistryForTests();
    });

    it("does not strip a company prefix for an unregistered plugin route", () => {
      // Before any plugin contribution data has loaded this session (or for a
      // route no installed plugin declares), there is nothing to recognize
      // "notepad" as a valid company-scoped route root by — this is the
      // documented, narrow, unavoidable gap described in
      // plugin-route-registry.ts, not a regression.
      expect(toCompanyRelativePath("/PER/notepad")).toBe("/PER/notepad");
    });

    it("strips the company prefix for a plugin route once it's registered", () => {
      // Simulates what useCompanyPageMemory.ts's usePluginRouteRootsSync does
      // once listUiContributions() resolves: registers every installed
      // plugin page's routePath so toCompanyRelativePath can recognize it,
      // fixing the "/PER/PER/notepad"-style double prefix from the audit
      // without a hand-maintained per-plugin allowlist here.
      registerPluginRouteRoots(["notepad", "campaigns"]);
      expect(toCompanyRelativePath("/PER/notepad")).toBe("/notepad");
      expect(toCompanyRelativePath("/PER/campaigns")).toBe("/campaigns");
      // A route no plugin has ever declared still isn't touched.
      expect(toCompanyRelativePath("/PER/some-other-thing")).toBe("/PER/some-other-thing");
    });

    it("recognizes a bare registered plugin route as having no company prefix (code review, 2026-09-02)", () => {
      // Regression caught by a code review pass, not by this file's own
      // earlier tests: toCompanyRelativePath got the plugin-registry fix
      // when this was first built, but its sibling extractCompanyPrefixFromPath
      // did not, even though ui/src/lib/router.tsx's applyCompanyPrefix calls
      // it to decide whether a navigation target already has a prefix. Before
      // this fix, a bare "/notepad" link (e.g. from the Command Palette's
      // Plugins group) had its route slug misread as an unrecognized company
      // code ("NOTEPAD"), so the real company prefix was never added and the
      // link landed on a "company not found" page instead of Notepad.
      registerPluginRouteRoots(["notepad"]);
      expect(extractCompanyPrefixFromPath("/notepad")).toBeNull();
      expect(applyCompanyPrefix("/notepad", "ACME")).toBe("/ACME/notepad");
    });

    it("still reads an unregistered path's first segment as a company prefix", () => {
      expect(extractCompanyPrefixFromPath("/notepad")).toBe("NOTEPAD");
      expect(applyCompanyPrefix("/notepad", "ACME")).toBe("/notepad");
    });
  });
});
