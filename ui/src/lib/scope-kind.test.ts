import { describe, expect, it } from "vitest";
import {
  isInstanceSettingsPath,
  isPortfolioRoutePath,
  resolveScopeKind,
} from "./scope-kind";

const hq = { isPortfolioRoot: true, kind: "standard" as const };
const standardCompany = { isPortfolioRoot: false, kind: "standard" as const };
const personalCompany = { isPortfolioRoot: false, kind: "personal" as const };

describe("isPortfolioRoutePath", () => {
  it("recognizes every portfolio-* root", () => {
    expect(isPortfolioRoutePath("/HQ/portfolio-brief")).toBe(true);
    expect(isPortfolioRoutePath("/HQ/portfolio-email")).toBe(true);
    expect(isPortfolioRoutePath("/portfolio-brief")).toBe(true);
  });

  it("does not treat an ordinary HQ page as portfolio scope", () => {
    // This is the exact gap the audit named: portfolio-* pages are mounted
    // under HQ's own company prefix, so the route alone can't be trusted —
    // only the presence of the "portfolio-" root distinguishes them from
    // HQ's own pages at the same URL depth.
    expect(isPortfolioRoutePath("/HQ/brief")).toBe(false);
    expect(isPortfolioRoutePath("/HQ/issues")).toBe(false);
  });
});

describe("isInstanceSettingsPath", () => {
  it("recognizes instance settings paths", () => {
    expect(isInstanceSettingsPath("/instance/settings/general")).toBe(true);
    expect(isInstanceSettingsPath("/instance")).toBe(true);
  });

  it("does not false-positive on an unrelated path", () => {
    expect(isInstanceSettingsPath("/HQ/brief")).toBe(false);
  });
});

describe("resolveScopeKind", () => {
  it("classifies a portfolio-* page as portfolio scope even though it's mounted under HQ", () => {
    expect(resolveScopeKind({ pathname: "/HQ/portfolio-brief", selectedCompany: hq })).toBe("portfolio");
  });

  it("classifies HQ's own pages as hq scope, not portfolio", () => {
    expect(resolveScopeKind({ pathname: "/HQ/brief", selectedCompany: hq })).toBe("hq");
  });

  it("classifies an ordinary company's pages as company scope", () => {
    expect(resolveScopeKind({ pathname: "/IND/brief", selectedCompany: standardCompany })).toBe("company");
  });

  it("classifies the personal company's pages as personal scope", () => {
    expect(resolveScopeKind({ pathname: "/PER/brief", selectedCompany: personalCompany })).toBe("personal");
  });

  it("classifies instance settings as instance scope regardless of selected company", () => {
    expect(resolveScopeKind({ pathname: "/instance/settings/general", selectedCompany: hq })).toBe("instance");
    expect(resolveScopeKind({ pathname: "/instance/settings/general", selectedCompany: null })).toBe("instance");
  });

  it("falls back to company scope with no selected company and no special path", () => {
    expect(resolveScopeKind({ pathname: "/brief", selectedCompany: null })).toBe("company");
  });
});
