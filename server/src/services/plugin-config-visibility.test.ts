import { describe, expect, it } from "vitest";
import { pluginConfigVisibleTo, type ConfigViewer } from "./plugin-config-visibility.js";

const MINE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const BOBS_PERSONAL = "33333333-3333-4333-8333-333333333333";
const ALL_COMPANIES = new Set([MINE, OTHER, BOBS_PERSONAL]);

const VIEWER: ConfigViewer = {
  canSeeCompany: (companyId) => companyId === MINE,
  isCompanyId: (value) => ALL_COMPANIES.has(value),
};

const companyIds = { type: "array", items: { type: "string", format: "company-id" } };

/** Shaped like the email plugin's: mailboxes, each naming the companies it serves. */
const EMAIL_SCHEMA = {
  type: "object",
  properties: {
    pollSeconds: { type: "number" },
    alertCompanyId: { type: "string", format: "company-id" },
    mailboxes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          address: { type: "string" },
          pass: { type: "string", format: "secret-ref" },
          allowedCompanies: companyIds,
          ingestCompanyId: { type: "string", format: "company-id" },
        },
      },
    },
  },
};

describe("pluginConfigVisibleTo", () => {
  it("keeps only the mailboxes that serve the caller, without other companies' ids", () => {
    const config = {
      pollSeconds: 60,
      alertCompanyId: BOBS_PERSONAL,
      mailboxes: [
        { key: "mine", address: "books@example.org", pass: "secret-1", allowedCompanies: [MINE] },
        { key: "bob", address: "bob.private@example.com", pass: "secret-2", allowedCompanies: [BOBS_PERSONAL] },
        {
          key: "shared",
          address: "ops@example.com",
          pass: "secret-3",
          allowedCompanies: ["*", BOBS_PERSONAL],
          ingestCompanyId: BOBS_PERSONAL,
        },
        { key: "both", address: "both@example.com", allowedCompanies: [OTHER, MINE] },
        { key: "unused", address: "unused@example.com", allowedCompanies: [] },
      ],
    };

    expect(pluginConfigVisibleTo(config, EMAIL_SCHEMA, VIEWER)).toEqual({
      pollSeconds: 60,
      mailboxes: [
        { key: "mine", address: "books@example.org", pass: "secret-1", allowedCompanies: [MINE] },
        { key: "shared", address: "ops@example.com", pass: "secret-3", allowedCompanies: ["*"] },
        { key: "both", address: "both@example.com", allowedCompanies: [MINE] },
      ],
    });
  });

  it("drops the parts of a shared account that belong to other companies", () => {
    // Shaped like the Help Scout plugin's: an account with per-company routes.
    const schema = {
      type: "object",
      properties: {
        accounts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              allowedCompanies: companyIds,
              supportIntakeRoutes: {
                type: "array",
                items: {
                  type: "object",
                  properties: { mailboxId: { type: "string" }, companyId: { type: "string", format: "company-id" } },
                },
              },
            },
          },
        },
      },
    };
    const config = {
      accounts: [
        {
          key: "support",
          allowedCompanies: ["*"],
          supportIntakeRoutes: [
            { mailboxId: "100", companyId: MINE },
            { mailboxId: "200", companyId: OTHER },
          ],
        },
      ],
    };

    expect(pluginConfigVisibleTo(config, schema, VIEWER)).toEqual({
      accounts: [{ key: "support", allowedCompanies: ["*"], supportIntakeRoutes: [{ mailboxId: "100", companyId: MINE }] }],
    });
  });

  it("finds company ids the schema does not mark, and settings keyed by one", () => {
    const config = {
      workspaces: [
        { name: "Mine", companies: [MINE] },
        { name: "Bob's", companies: [BOBS_PERSONAL] },
      ],
      perCompany: { [MINE]: { tone: "plain" }, [OTHER]: { tone: "formal" } },
      note: "not a company",
    };

    expect(pluginConfigVisibleTo(config, undefined, VIEWER)).toEqual({
      workspaces: [{ name: "Mine", companies: [MINE] }],
      perCompany: { [MINE]: { tone: "plain" } },
      note: "not a company",
    });
  });

  it("follows fields declared under allOf, anyOf and oneOf", () => {
    const schema = {
      allOf: [
        { type: "object", properties: { pollSeconds: { type: "number" } } },
        { type: "object", properties: { mailboxes: EMAIL_SCHEMA.properties.mailboxes } },
      ],
    };
    const config = {
      mailboxes: [
        { key: "mine", allowedCompanies: [MINE] },
        { key: "unused", allowedCompanies: [] },
      ],
    };

    expect(pluginConfigVisibleTo(config, schema, VIEWER)).toEqual({
      mailboxes: [{ key: "mine", allowedCompanies: [MINE] }],
    });
  });

  it("does not change the config it was given", () => {
    const config = { mailboxes: [{ key: "bob", allowedCompanies: [BOBS_PERSONAL] }] };
    const before = JSON.stringify(config);

    pluginConfigVisibleTo(config, EMAIL_SCHEMA, VIEWER);

    expect(JSON.stringify(config)).toBe(before);
  });
});
