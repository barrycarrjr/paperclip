import { describe, expect, it } from "vitest";
import {
  companyPathForPortfolioPage,
  isInstanceSettingsPath,
  isPortfolioRoutePath,
  isPortfolioScopeAvailable,
  portfolioPathForPage,
  resolveScopeChoiceDescription,
  resolveScopeChoices,
  resolveScopeExplanation,
  resolveScopeKind,
  resolveScopeLabelText,
  type ScopeChoiceCompany,
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
    expect(isPortfolioRoutePath("/HQ/portfolio-agents/org")).toBe(true);
    expect(isPortfolioRoutePath("/portfolio-agents/assistants")).toBe(true);
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
    expect(resolveScopeLabelText({ scopeKind: "personal", companyName: "Alex", portfolioCompanyCount: 3 }))
      .toBe("Alex");
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
    expect(resolveScopeExplanation({ scopeKind: "personal", companyName: "Alex", portfolioCompanyCount: 4 }))
      .toEqual({
        title: "Alex",
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

describe("portfolioPathForPage", () => {
  it("opens the all company version of the page you are on", () => {
    expect(portfolioPathForPage("/ACM/costs")).toBe("/portfolio-costs");
    expect(portfolioPathForPage("/ACM/email")).toBe("/portfolio-email");
    expect(portfolioPathForPage("/ACM/calendar")).toBe("/portfolio-calendar");
    expect(portfolioPathForPage("/ACM/brief")).toBe("/portfolio-brief");
  });

  it("preserves the active Team view when opening Portfolio Teams", () => {
    expect(portfolioPathForPage("/ACM/team")).toBe("/portfolio-agents");
    expect(portfolioPathForPage("/ACM/team/timeline")).toBe("/portfolio-agents/timeline");
    expect(portfolioPathForPage("/ACM/agents/all")).toBe("/portfolio-agents/agents");
    expect(portfolioPathForPage("/ACM/org")).toBe("/portfolio-agents/org");
    expect(portfolioPathForPage("/ACM/assistants")).toBe("/portfolio-agents/assistants");
  });

  it("keeps the page when a deeper address still names a page that has an all company version", () => {
    expect(portfolioPathForPage("/ACM/issues/ACM-12")).toBe("/portfolio-issues");
  });

  it("falls back to the Portfolio Overview where there is no all company version", () => {
    expect(portfolioPathForPage("/ACM/memories")).toBe("/portfolio-brief");
    expect(portfolioPathForPage("/ACM/projects")).toBe("/portfolio-brief");
    expect(portfolioPathForPage("/instance/settings/general")).toBe("/portfolio-brief");
    expect(portfolioPathForPage("/")).toBe("/portfolio-brief");
  });

  it("stays put when you are already on a portfolio page", () => {
    expect(portfolioPathForPage("/HQ/portfolio-costs")).toBe("/portfolio-costs");
    expect(portfolioPathForPage("/HQ/portfolio-directives")).toBe("/portfolio-directives");
    expect(portfolioPathForPage("/HQ/portfolio-agents/timeline")).toBe(
      "/portfolio-agents/timeline",
    );
  });
});

describe("companyPathForPortfolioPage", () => {
  it("comes back to the same page for one company", () => {
    expect(companyPathForPortfolioPage("/HQ/portfolio-costs")).toBe("/costs");
    expect(companyPathForPortfolioPage("/HQ/portfolio-email")).toBe("/email");
    expect(companyPathForPortfolioPage("/HQ/portfolio-brief")).toBe("/brief");
  });

  it("preserves the active Portfolio Teams view when returning to one company", () => {
    expect(companyPathForPortfolioPage("/HQ/portfolio-agents")).toBe("/team");
    expect(companyPathForPortfolioPage("/HQ/portfolio-agents/timeline")).toBe("/team/timeline");
    expect(companyPathForPortfolioPage("/HQ/portfolio-agents/agents")).toBe("/agents/all");
    expect(companyPathForPortfolioPage("/HQ/portfolio-agents/org")).toBe("/org");
    expect(companyPathForPortfolioPage("/HQ/portfolio-agents/assistants")).toBe("/assistants");
  });

  it("falls back to the Overview from a portfolio page with no per company twin", () => {
    expect(companyPathForPortfolioPage("/HQ/portfolio-directives")).toBe("/brief");
  });

  it("answers null anywhere that is not a portfolio page, so an ordinary switch is left alone", () => {
    expect(companyPathForPortfolioPage("/HQ/costs")).toBeNull();
    expect(companyPathForPortfolioPage("/ACM/brief")).toBeNull();
    expect(companyPathForPortfolioPage("/instance/settings/general")).toBeNull();
  });
});

describe("isPortfolioScopeAvailable", () => {
  it("offers Portfolio once there is an HQ and something to add up", () => {
    expect(isPortfolioScopeAvailable({ hasPortfolioRoot: true, portfolioCompanyCount: 1 })).toBe(true);
    expect(isPortfolioScopeAvailable({ hasPortfolioRoot: true, portfolioCompanyCount: 4 })).toBe(true);
  });

  it("does not offer Portfolio to somebody who can only reach one company", () => {
    // A total of one company is that company, so the button would lead
    // somewhere that repeats the page they are already on.
    expect(isPortfolioScopeAvailable({ hasPortfolioRoot: true, portfolioCompanyCount: 0 })).toBe(false);
  });

  it("does not offer Portfolio with no HQ, because the pages live under HQ's address", () => {
    expect(isPortfolioScopeAvailable({ hasPortfolioRoot: false, portfolioCompanyCount: 3 })).toBe(false);
  });
});

describe("resolveScopeChoiceDescription", () => {
  it("says HQ is its own team rather than the all company total", () => {
    expect(
      resolveScopeChoiceDescription({ scopeKind: "hq", companyName: "HQ", portfolioCompanyCount: 2 }),
    ).toBe("Its own team and work, not the all company total.");
  });

  it("reuses the explanation copy for the other scopes so the two cannot drift apart", () => {
    const portfolio = resolveScopeChoiceDescription({
      scopeKind: "portfolio",
      companyName: null,
      portfolioCompanyCount: 2,
    });
    expect(portfolio).toBe(
      resolveScopeExplanation({ scopeKind: "portfolio", companyName: null, portfolioCompanyCount: 2 }).meaning,
    );
    const company = resolveScopeChoiceDescription({
      scopeKind: "company",
      companyName: "Acme Printing",
      portfolioCompanyCount: 2,
    });
    expect(company).toBe(
      resolveScopeExplanation({ scopeKind: "company", companyName: "Acme Printing", portfolioCompanyCount: 2 })
        .includes,
    );
  });
});

describe("resolveScopeChoices", () => {
  const HQ: ScopeChoiceCompany = {
    id: "company-hq",
    name: "HQ",
    issuePrefix: "HQ",
    isPortfolioRoot: true,
    kind: "standard",
    status: "active",
  };
  const ACME: ScopeChoiceCompany = {
    id: "company-acme",
    name: "Acme Printing",
    issuePrefix: "ACM",
    isPortfolioRoot: false,
    kind: "standard",
    status: "active",
  };
  const PERSONAL: ScopeChoiceCompany = {
    id: "company-personal",
    name: "Alex",
    issuePrefix: "PER",
    isPortfolioRoot: false,
    kind: "personal",
    status: "active",
  };
  const CLOSED: ScopeChoiceCompany = { ...ACME, id: "company-old", name: "Old Shop", status: "archived" };

  function choices(overrides?: Partial<Parameters<typeof resolveScopeChoices>[0]>) {
    return resolveScopeChoices({
      companies: [HQ, ACME, PERSONAL],
      scopeKind: "company",
      activeCompanyId: ACME.id,
      portfolioCompanyCount: 2,
      ...overrides,
    });
  }

  it("puts Portfolio first and HQ directly below it", () => {
    const result = choices();
    expect(result.map((c) => c.title)).toEqual(["Portfolio", "HQ", "Acme Printing", "Alex"]);
    expect(result[0]!.kind).toBe("portfolio");
    expect(result[1]!.kind).toBe("hq");
  });

  it("separates the two by describing HQ as its own team, not the all company total", () => {
    const result = choices();
    expect(result[0]!.description).toBe("All the companies you can open, added together in one view.");
    expect(result[1]!.description).toBe("Its own team and work, not the all company total.");
  });

  it("leaves Portfolio out for somebody who can only reach one company", () => {
    const result = choices({ companies: [HQ], portfolioCompanyCount: 0, activeCompanyId: HQ.id, scopeKind: "hq" });
    expect(result.map((c) => c.title)).toEqual(["HQ"]);
  });

  it("leaves Portfolio out when there is no HQ to hang it under", () => {
    const result = choices({ companies: [ACME, PERSONAL], portfolioCompanyCount: 2 });
    expect(result.map((c) => c.title)).toEqual(["Acme Printing", "Alex"]);
  });

  it("marks the company you are in", () => {
    const result = choices();
    expect(result.find((c) => c.title === "Acme Printing")!.current).toBe(true);
    expect(result.filter((c) => c.current)).toHaveLength(1);
  });

  it("marks Portfolio, and not HQ, while a portfolio page is open", () => {
    // The two share an address prefix, so HQ is the selected company on a
    // portfolio page. Ticking both would say you are in two places.
    const result = choices({ scopeKind: "portfolio", activeCompanyId: HQ.id });
    expect(result.find((c) => c.title === "Portfolio")!.current).toBe(true);
    expect(result.find((c) => c.title === "HQ")!.current).toBe(false);
  });

  it("marks nothing in instance settings, which are not a company", () => {
    const result = choices({ scopeKind: "instance", activeCompanyId: ACME.id });
    expect(result.filter((c) => c.current)).toHaveLength(0);
  });

  it("describes the private company as private rather than as an ordinary workspace", () => {
    const result = choices();
    expect(result.find((c) => c.title === "Alex")!.description).toContain("private to-dos and notes");
  });

  it("leaves out archived companies", () => {
    const result = choices({ companies: [HQ, ACME, CLOSED] });
    expect(result.map((c) => c.title)).not.toContain("Old Shop");
  });

  it("carries the company on every company row, so a caller can address it", () => {
    for (const choice of choices()) {
      if (choice.kind === "portfolio") {
        expect(choice.company).toBeNull();
      } else {
        expect(choice.company?.issuePrefix.length).toBeGreaterThan(0);
      }
    }
  });

  it("uses no dash characters a person would have to decode", () => {
    for (const choice of choices()) {
      expect(`${choice.title} ${choice.description}`).not.toMatch(/[–—]/);
    }
  });
});
