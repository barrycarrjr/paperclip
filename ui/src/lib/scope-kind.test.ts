import { describe, expect, it } from "vitest";
import {
  isInstanceSettingsPath,
  isPortfolioRoutePath,
  resolveScopeExplanation,
  resolveScopeKind,
  resolveScopeLabelText,
  type ScopeKind,
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
    // under HQ's own company prefix, so the route alone can't be trusted,
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

describe("resolveScopeLabelText", () => {
  it("names the company for company, HQ and personal scope", () => {
    expect(resolveScopeLabelText({ scopeKind: "company", companyName: "Acme Printing", portfolioCompanyCount: 3 }))
      .toBe("Acme Printing");
    expect(resolveScopeLabelText({ scopeKind: "hq", companyName: "HQ", portfolioCompanyCount: 3 }))
      .toBe("HQ");
    expect(resolveScopeLabelText({ scopeKind: "personal", companyName: "Barry", portfolioCompanyCount: 3 }))
      .toBe("Barry");
  });

  it("counts the portfolio's companies and gets the plural right", () => {
    expect(resolveScopeLabelText({ scopeKind: "portfolio", companyName: "HQ", portfolioCompanyCount: 4 }))
      .toBe("Portfolio · 4 companies");
    expect(resolveScopeLabelText({ scopeKind: "portfolio", companyName: "HQ", portfolioCompanyCount: 1 }))
      .toBe("Portfolio · 1 company");
    expect(resolveScopeLabelText({ scopeKind: "portfolio", companyName: "HQ", portfolioCompanyCount: 0 }))
      .toBe("Portfolio");
  });

  it("returns nothing when no company has resolved yet, so the caller can skip the button", () => {
    expect(resolveScopeLabelText({ scopeKind: "company", companyName: null, portfolioCompanyCount: 0 }))
      .toBeNull();
  });

  it("labels instance settings without a company name", () => {
    expect(resolveScopeLabelText({ scopeKind: "instance", companyName: "Acme Printing", portfolioCompanyCount: 3 }))
      .toBe("Instance settings");
  });
});

describe("resolveScopeExplanation", () => {
  // The button's whole job is telling these two apart at the same URL depth,
  // so the sentences must not read alike.
  it("says the portfolio is every company added together, and never defaults to HQ", () => {
    expect(resolveScopeExplanation({ scopeKind: "portfolio", companyName: "HQ", portfolioCompanyCount: 4 }))
      .toEqual({
        title: "Portfolio",
        meaning: "All the companies you can open, added together in one view.",
        includes: "Covers the 4 companies you can open.",
        guardrail: "Anything you start here has to name the company it is for. It never quietly goes to HQ.",
      });
  });

  it("says HQ scope is HQ's own work and not the all company total", () => {
    expect(resolveScopeExplanation({ scopeKind: "hq", companyName: "HQ", portfolioCompanyCount: 4 }))
      .toEqual({
        title: "HQ",
        meaning: "HQ's own agents, work and records.",
        includes: "Only HQ's own work. It leaves out the other companies.",
        guardrail: "This is not the all company total. Open Portfolio for that.",
      });
  });

  it("says a company scope keeps everything inside that company", () => {
    expect(resolveScopeExplanation({ scopeKind: "company", companyName: "Acme Printing", portfolioCompanyCount: 4 }))
      .toEqual({
        title: "Acme Printing",
        meaning: "One company's own working area.",
        includes: "Its email, calendar, team, work and records.",
        guardrail: "Searches, records, actions and agent choices all stay inside this company.",
      });
  });

  it("says the personal scope is private and follows the person", () => {
    expect(resolveScopeExplanation({ scopeKind: "personal", companyName: "Barry", portfolioCompanyCount: 4 }))
      .toEqual({
        title: "Barry",
        meaning: "Your own private space.",
        includes: "Your private to-dos and notes, which follow you from company to company.",
        guardrail: "Nothing here is shared with a company's agents unless you share it.",
      });
  });

  it("says instance settings are not limited to one company", () => {
    expect(resolveScopeExplanation({ scopeKind: "instance", companyName: "Acme Printing", portfolioCompanyCount: 4 }))
      .toEqual({
        title: "Instance settings",
        meaning: "Settings for this whole Paperclip install.",
        includes: "Every company on it, not just the one you were last in.",
        guardrail: "A change here applies everywhere, so it is not limited to one company.",
      });
  });

  it("still has a heading when no company name has resolved", () => {
    expect(resolveScopeExplanation({ scopeKind: "hq", companyName: null, portfolioCompanyCount: 0 }).title)
      .toBe("HQ");
    expect(resolveScopeExplanation({ scopeKind: "company", companyName: null, portfolioCompanyCount: 0 }).title)
      .toBe("Company workspace");
    expect(resolveScopeExplanation({ scopeKind: "personal", companyName: null, portfolioCompanyCount: 0 }).title)
      .toBe("Personal");
  });

  it("gets the plural right when the portfolio holds one company, and copes with none", () => {
    expect(resolveScopeExplanation({ scopeKind: "portfolio", companyName: "HQ", portfolioCompanyCount: 1 }).includes)
      .toBe("Covers the 1 company you can open.");
    expect(resolveScopeExplanation({ scopeKind: "portfolio", companyName: "HQ", portfolioCompanyCount: 0 }).includes)
      .toBe("Covers every company you can open.");
  });

  // Every scope the app can classify has to have copy, or the button opens on
  // nothing. This fails the moment a sixth ScopeKind is added without wording.
  it("has all four sentences for every scope the app can classify", () => {
    const kinds: ScopeKind[] = ["portfolio", "hq", "company", "personal", "instance"];
    for (const scopeKind of kinds) {
      const explanation = resolveScopeExplanation({ scopeKind, companyName: "Acme Printing", portfolioCompanyCount: 2 });
      expect(explanation.title.length, scopeKind).toBeGreaterThan(0);
      expect(explanation.meaning.length, scopeKind).toBeGreaterThan(0);
      expect(explanation.includes.length, scopeKind).toBeGreaterThan(0);
      expect(explanation.guardrail.length, scopeKind).toBeGreaterThan(0);
    }
  });

  // No em dashes or en dashes in anything that reaches a screen.
  it("uses no dash characters a person would have to decode", () => {
    const kinds: ScopeKind[] = ["portfolio", "hq", "company", "personal", "instance"];
    for (const scopeKind of kinds) {
      const explanation = resolveScopeExplanation({ scopeKind, companyName: "Acme Printing", portfolioCompanyCount: 2 });
      const all = [explanation.title, explanation.meaning, explanation.includes, explanation.guardrail].join(" ");
      expect(all, scopeKind).not.toMatch(/[–—]/);
    }
  });
});
