import { describe, expect, it } from "vitest";
import type { PluginConnectorDeclaration } from "@paperclipai/shared";
import { readConnectorAccounts, resolveConnectorCompanies } from "./plugin-connectors.js";

const CONNECTOR: PluginConnectorDeclaration = {
  id: "google-calendar",
  surface: "calendar",
  displayName: "Google Calendar",
  connectionsKey: "accounts",
  companiesField: "allowedCompanies",
  labelField: "userEmail",
  requiredFields: ["refreshTokenRef"],
};

const COMPANIES = [
  { id: "company-a", name: "Industry Bureau LLC" },
  { id: "company-b", name: "Print Shop" },
];

function resolve(configJson: Record<string, unknown> | null) {
  return resolveConnectorCompanies(CONNECTOR, readConnectorAccounts(CONNECTOR, configJson), COMPANIES);
}

describe("plugin connectors", () => {
  it("reports every company as not connected when the plugin has no config", () => {
    const result = resolve(null);

    expect(result.companies).toEqual([
      {
        companyId: "company-a",
        companyName: "Industry Bureau LLC",
        connected: false,
        accountLabel: null,
        viaPortfolioWide: false,
      },
      {
        companyId: "company-b",
        companyName: "Print Shop",
        connected: false,
        accountLabel: null,
        viaPortfolioWide: false,
      },
    ]);
    expect(result.unfinishedAccounts).toEqual([]);
  });

  it("connects only the companies an account names", () => {
    const result = resolve({
      accounts: [
        {
          key: "ib",
          userEmail: "books@industrybureau.com",
          allowedCompanies: ["company-a"],
          refreshTokenRef: "secret-uuid",
        },
      ],
    });

    expect(result.companies[0]).toMatchObject({
      companyId: "company-a",
      connected: true,
      accountLabel: "books@industrybureau.com",
      viaPortfolioWide: false,
    });
    expect(result.companies[1]).toMatchObject({ companyId: "company-b", connected: false });
  });

  it("treats a portfolio-wide account as covering every company", () => {
    const result = resolve({
      accounts: [
        { key: "all", userEmail: "ops@example.com", allowedCompanies: ["*"], refreshTokenRef: "secret" },
      ],
    });

    expect(result.companies.every((company) => company.connected)).toBe(true);
    expect(result.companies.every((company) => company.viaPortfolioWide)).toBe(true);
  });

  it("prefers the account that names the company over the portfolio-wide one", () => {
    const result = resolve({
      accounts: [
        { key: "all", userEmail: "ops@example.com", allowedCompanies: ["*"], refreshTokenRef: "secret" },
        { key: "ib", userEmail: "books@ib.com", allowedCompanies: ["company-a"], refreshTokenRef: "secret" },
      ],
    });

    expect(result.companies[0]).toMatchObject({
      accountLabel: "books@ib.com",
      viaPortfolioWide: false,
    });
    expect(result.companies[1]).toMatchObject({
      accountLabel: "ops@example.com",
      viaPortfolioWide: true,
    });
  });

  // A half-filled account is the likeliest real-world state: the operator added
  // the row, then went off to fetch the refresh token. Reading that as
  // "connected" would be worse than saying nothing.
  it("does not count an account that is still missing its credentials", () => {
    const result = resolve({
      accounts: [
        { key: "ib", userEmail: "books@ib.com", allowedCompanies: ["company-a"], refreshTokenRef: "" },
      ],
    });

    expect(result.companies[0].connected).toBe(false);
    expect(result.unfinishedAccounts).toEqual(["books@ib.com"]);
  });

  it("reads an account with an empty company list as unusable, matching plugin deny rules", () => {
    const result = resolve({
      accounts: [{ key: "ib", userEmail: "books@ib.com", allowedCompanies: [], refreshTokenRef: "secret" }],
    });

    expect(result.companies.every((company) => company.connected)).toBe(false);
  });

  it("survives config that is not shaped the way the connector expects", () => {
    expect(resolve({ accounts: "not-an-array" }).companies).toHaveLength(2);
    expect(resolve({}).companies).toHaveLength(2);
    expect(resolve({ accounts: [null, 42, "x"] }).companies.every((c) => !c.connected)).toBe(true);
  });

  it("falls back to the account key when the connector named no label field", () => {
    const withoutLabel: PluginConnectorDeclaration = { ...CONNECTOR, labelField: undefined };
    const accounts = readConnectorAccounts(withoutLabel, {
      accounts: [{ key: "ib", allowedCompanies: ["company-a"], refreshTokenRef: "secret" }],
    });

    expect(resolveConnectorCompanies(withoutLabel, accounts, COMPANIES).companies[0].accountLabel).toBe("ib");
  });

  it("counts an account as finished when the connector requires no fields", () => {
    const noRequirements: PluginConnectorDeclaration = { ...CONNECTOR, requiredFields: undefined };
    const accounts = readConnectorAccounts(noRequirements, {
      accounts: [{ key: "ib", allowedCompanies: ["company-a"] }],
    });

    expect(resolveConnectorCompanies(noRequirements, accounts, COMPANIES).companies[0].connected).toBe(true);
  });
});
