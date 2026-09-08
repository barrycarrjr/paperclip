import { describe, expect, it } from "vitest";
import { resolveCompanySwitchDestination, workspaceLabelForPath } from "./company-switch";

const acme = { name: "Acme", isPortfolioRoot: false };
const hq = { name: "HQ", isPortfolioRoot: true };

function switchTo(
  currentPath: string,
  toCompany = acme,
  fromCompanyName: string | null = "Paperclip",
) {
  return resolveCompanySwitchDestination({ currentPath, toCompany, fromCompanyName });
}

describe("resolveCompanySwitchDestination", () => {
  it("keeps you on the same page", () => {
    const result = switchTo("/PAP/calendar");
    expect(result.path).toBe("/calendar");
    expect(result.kind).toBe("same_page");
    expect(result.title).toBe("Now in Acme");
    expect(result.body).toBe("Kept you on Calendar.");
  });

  it("keeps a page that is already company relative", () => {
    expect(switchTo("/inbox/unread").path).toBe("/inbox/unread");
  });

  it("keeps a list's own views rather than treating them as records", () => {
    expect(switchTo("/PAP/issues/backlog").kind).toBe("same_page");
    expect(switchTo("/PAP/agents/paused").kind).toBe("same_page");
    expect(switchTo("/PAP/approvals/pending").kind).toBe("same_page");
  });

  it("drops a record belonging to the company you left, and says whose it was", () => {
    const result = switchTo("/PAP/issues/PAP-12");
    expect(result.path).toBe("/issues");
    expect(result.kind).toBe("record_left_behind");
    expect(result.body).toBe("Opened Tasks. The task you had open belongs to Paperclip.");
  });

  it("drops the record from every page that can name one", () => {
    expect(switchTo("/PAP/projects/p-1").path).toBe("/projects");
    expect(switchTo("/PAP/goals/g-1").path).toBe("/goals");
    expect(switchTo("/PAP/routines/r-1").path).toBe("/routines");
    expect(switchTo("/PAP/approvals/a-1").path).toBe("/approvals");
    expect(switchTo("/PAP/agents/agent-1/runs/run-2").path).toBe("/agents/all");
    expect(switchTo("/PAP/execution-workspaces/w-1").path).toBe("/workspaces");
    expect(switchTo("/PAP/skills/skill-1/files/SKILL.md").path).toBe("/skills");
  });

  it("names the company you left as unknown when it cannot be worked out", () => {
    const result = switchTo("/PAP/issues/PAP-12", acme, null);
    expect(result.body).toBe(
      "Opened Tasks. The task you had open belongs to the company you left.",
    );
  });

  it("leaves a half filled form behind instead of refiling it", () => {
    const result = switchTo("/PAP/agents/new");
    expect(result.path).toBe("/agents/all");
    expect(result.kind).toBe("form_left_behind");
    expect(result.body).toBe(
      "Opened Agents. What you had open was for Paperclip and was not carried over.",
    );
    expect(switchTo("/PAP/assistants/agent-1/edit").kind).toBe("form_left_behind");
    expect(switchTo("/PAP/company/import").path).toBe("/company/settings");
  });

  it("opens the new company's own settings rather than dropping you", () => {
    expect(switchTo("/PAP/company/settings/access").kind).toBe("same_page");
    expect(switchTo("/PAP/company/settings/access").path).toBe("/company/settings/access");
  });

  it("swaps an all company page for the new company's own version of it", () => {
    const result = switchTo("/HQ/portfolio-costs");
    expect(result.path).toBe("/costs");
    expect(result.kind).toBe("portfolio_swapped");
    expect(result.body).toBe(
      "Portfolio Costs adds every company together, so this is Acme's own Costs.",
    );
  });

  it("reads properly when the company name already ends in s", () => {
    const result = resolveCompanySwitchDestination({
      currentPath: "/HQ/portfolio-costs",
      toCompany: { name: "Carr Rock Holdings", isPortfolioRoot: false },
      fromCompanyName: "HQ",
    });
    expect(result.body).toBe(
      "Portfolio Costs adds every company together, so this is Carr Rock Holdings' own Costs.",
    );
  });

  it("falls back to the Overview for an all company page with no company version", () => {
    const result = switchTo("/HQ/portfolio-directives");
    expect(result.path).toBe("/brief");
    expect(result.kind).toBe("portfolio_unavailable");
    expect(result.body).toBe(
      "Portfolio Directives adds every company together, and Acme has no page of its own like it, so this is its Overview.",
    );
  });

  it("keeps an all company page when the company you picked is HQ", () => {
    const result = resolveCompanySwitchDestination({
      currentPath: "/HQ/portfolio-costs",
      toCompany: hq,
      fromCompanyName: "Acme",
    });
    expect(result.path).toBe("/portfolio-costs");
    expect(result.kind).toBe("same_page");
  });

  it("sends you to the Overview from a page that is not part of a company", () => {
    const result = switchTo("/instance/settings/general");
    expect(result.path).toBe("/brief");
    expect(result.kind).toBe("not_a_company_page");
  });

  it("never builds a second company prefix out of a bare company address", () => {
    const result = switchTo("/PAP");
    expect(result.path).toBe("/brief");
    expect(result.kind).toBe("not_a_company_page");
  });

  it("drops the search string, which is where selections hide", () => {
    expect(switchTo("/PAP/email?uid=4821&mailbox=support").path).toBe("/email");
  });
});

describe("workspaceLabelForPath", () => {
  it("uses the name the rest of the app shows", () => {
    expect(workspaceLabelForPath("/issues")).toBe("Tasks");
    expect(workspaceLabelForPath("/portfolio-costs")).toBe("Portfolio Costs");
    expect(workspaceLabelForPath("/brief")).toBe("Overview");
  });

  it("has no name for a page that is not in the catalog", () => {
    expect(workspaceLabelForPath("/company/settings")).toBeNull();
  });
});
