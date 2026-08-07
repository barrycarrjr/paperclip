// @vitest-environment node

import { describe, expect, it } from "vitest";
import { chooseHomeRoute } from "./home-route";

const HQ = { issuePrefix: "HQ", isPortfolioRoot: true, status: "active" };
const CAR = { issuePrefix: "CAR", isPortfolioRoot: false, status: "active" };
const PER = { issuePrefix: "PER", isPortfolioRoot: false, status: "active" };

describe("chooseHomeRoute", () => {
  it("opens on everything when there are several companies to watch", () => {
    // The case this exists for: ten agents across four companies failing for
    // three days, while the Brief on screen covered one of them.
    expect(chooseHomeRoute({ companies: [HQ, CAR, PER] })).toBe("/HQ/portfolio-brief");
  });

  it("opens on everything even when you were last inside one company", () => {
    // "/" means home, not "wherever I happened to be". Deep links into a
    // company are untouched; this only decides the front door.
    expect(chooseHomeRoute({ companies: [HQ, CAR, PER], selectedCompany: CAR })).toBe(
      "/HQ/portfolio-brief",
    );
  });

  it("leaves a single-company instance exactly as it was", () => {
    // A portfolio view of one company is a worse version of that company's
    // Brief, so nothing changes for the ordinary install.
    expect(chooseHomeRoute({ companies: [CAR] })).toBe("/CAR/brief");
    expect(chooseHomeRoute({ companies: [HQ] })).toBe("/HQ/brief");
  });

  it("falls back to a company Brief when nothing is the portfolio root", () => {
    expect(chooseHomeRoute({ companies: [CAR, PER] })).toBe("/CAR/brief");
    expect(chooseHomeRoute({ companies: [CAR, PER], selectedCompany: PER })).toBe("/PER/brief");
  });

  it("does not count archived companies as somewhere to look", () => {
    // One live company plus a pile of archived ones is still one company.
    const archived = { issuePrefix: "OLD", isPortfolioRoot: false, status: "archived" };
    expect(chooseHomeRoute({ companies: [HQ, archived, archived] })).toBe("/HQ/brief");
  });

  it("does not send you to an archived portfolio root", () => {
    const archivedHq = { issuePrefix: "HQ", isPortfolioRoot: true, status: "archived" };
    expect(chooseHomeRoute({ companies: [archivedHq, CAR, PER] })).toBe("/CAR/brief");
  });

  it("skips a portfolio root with no prefix to route to", () => {
    // A route needs a prefix; without one the link would 404 on the front door,
    // which is the worst possible place for it.
    const prefixless = { issuePrefix: null, isPortfolioRoot: true, status: "active" };
    expect(chooseHomeRoute({ companies: [prefixless, CAR, PER] })).toBe("/CAR/brief");
  });

  it("says nowhere rather than guessing when there is nothing to open", () => {
    // The caller already shows the no-companies start page for this.
    expect(chooseHomeRoute({ companies: [] })).toBeNull();
    expect(
      chooseHomeRoute({ companies: [{ issuePrefix: null, status: "active" }] }),
    ).toBeNull();
  });
});
