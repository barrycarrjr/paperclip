import { describe, expect, it } from "vitest";
import {
  shouldClearTransientSelectionSource,
  shouldRestoreRememberedPath,
  shouldSyncCompanySelectionFromRoute,
} from "./company-selection";

describe("shouldSyncCompanySelectionFromRoute", () => {
  it("does not resync when selection already matches the route", () => {
    expect(
      shouldSyncCompanySelectionFromRoute({
        selectionSource: "route_sync",
        selectedCompanyId: "pap",
        routeCompanyId: "pap",
      }),
    ).toBe(false);
  });

  it("defers route sync while a manual company switch is in flight", () => {
    expect(
      shouldSyncCompanySelectionFromRoute({
        selectionSource: "manual",
        selectedCompanyId: "pap",
        routeCompanyId: "ret",
      }),
    ).toBe(false);
  });

  it("defers route sync while a shortcut company switch is in flight (B01)", () => {
    // Same reasoning as the manual case above: SidebarNavItem.tsx's
    // hover-flyout click sets source "shortcut" and navigates straight to
    // its own target before the URL has caught up. Without this, Layout's
    // route-driven resync could yank selectedCompanyId back before the
    // shortcut's own navigate() call settles.
    expect(
      shouldSyncCompanySelectionFromRoute({
        selectionSource: "shortcut",
        selectedCompanyId: "pap",
        routeCompanyId: "ret",
      }),
    ).toBe(false);
  });

  it("syncs back to the route company for non-manual mismatches", () => {
    expect(
      shouldSyncCompanySelectionFromRoute({
        selectionSource: "route_sync",
        selectedCompanyId: "pap",
        routeCompanyId: "ret",
      }),
    ).toBe(true);
  });
});

describe("shouldRestoreRememberedPath", () => {
  it("restores the remembered page for a plain manual switch or initial bootstrap", () => {
    expect(shouldRestoreRememberedPath("manual")).toBe(true);
    expect(shouldRestoreRememberedPath("bootstrap")).toBe(true);
  });

  it("does not restore the remembered page when the URL already drove the selection", () => {
    expect(shouldRestoreRememberedPath("route_sync")).toBe(false);
  });

  it("does not restore the remembered page for an explicit shortcut click (B01)", () => {
    // The regression this fixes: SidebarNavItem.tsx's hover-flyout click
    // navigates straight to a specific destination (e.g. Email), which used
    // to get silently overwritten by the remembered-path replay because it
    // reused "manual" and this returned true for it too. See the comment
    // above CompanySelectionSource in ./company-selection.ts for the full
    // trace and why three other files needed to change together.
    expect(shouldRestoreRememberedPath("shortcut")).toBe(false);
  });
});

describe("shouldClearTransientSelectionSource", () => {
  it("clears manual and shortcut once the URL has caught up to the selection", () => {
    expect(shouldClearTransientSelectionSource("manual")).toBe(true);
    expect(shouldClearTransientSelectionSource("shortcut")).toBe(true);
  });

  it("leaves route_sync and bootstrap alone — they were never transient", () => {
    // Regression guard: PortfolioBrief.tsx pre-flips to "route_sync" before
    // navigating specifically so it never enters this transient state at
    // all. If this ever started clearing "route_sync" or "bootstrap" too, a
    // real selection made through those paths could be reset unexpectedly.
    expect(shouldClearTransientSelectionSource("route_sync")).toBe(false);
    expect(shouldClearTransientSelectionSource("bootstrap")).toBe(false);
  });
});
