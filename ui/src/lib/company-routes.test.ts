import { describe, expect, it } from "vitest";
import {
  applyCompanyPrefix,
  extractCompanyPrefixFromPath,
  isBoardPathWithoutPrefix,
  toCompanyRelativePath,
} from "./company-routes";

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
});
