import { describe, expect, it } from "vitest";
import { keepUnseenParts, pluginConfigVisibleTo, type ConfigViewer } from "./plugin-config-visibility.js";

const MINE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const BOBS_PERSONAL = "33333333-3333-4333-8333-333333333333";
const ALL_COMPANIES = new Set([MINE, OTHER, BOBS_PERSONAL]);

/** A member of one company. */
const VIEWER: ConfigViewer = {
  canSeeCompany: (companyId) => companyId === MINE,
  isCompanyId: (value) => ALL_COMPANIES.has(value),
  seesUnassigned: false,
};

/** An instance admin: every company except someone else's Personal, and entries still being set up. */
const ADMIN: ConfigViewer = {
  canSeeCompany: (companyId) => companyId !== BOBS_PERSONAL,
  isCompanyId: (value) => ALL_COMPANIES.has(value),
  seesUnassigned: true,
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

  it("leaves out only someone else's Personal parts for an instance admin", () => {
    const config = {
      mailboxes: [
        { key: "bob", allowedCompanies: [BOBS_PERSONAL] },
        { key: "shared", allowedCompanies: ["*", BOBS_PERSONAL], ingestCompanyId: BOBS_PERSONAL },
        { key: "other", allowedCompanies: [OTHER] },
        { key: "new", allowedCompanies: [] },
      ],
    };

    expect(pluginConfigVisibleTo(config, EMAIL_SCHEMA, ADMIN)).toEqual({
      mailboxes: [
        { key: "shared", allowedCompanies: ["*"] },
        { key: "other", allowedCompanies: [OTHER] },
        { key: "new", allowedCompanies: [] },
      ],
    });
  });
});

describe("keepUnseenParts", () => {
  const EMAIL_CONFIG = {
    pollSeconds: 60,
    alertCompanyId: BOBS_PERSONAL,
    mailboxes: [
      { key: "mine", address: "books@example.org", allowedCompanies: [MINE] },
      { key: "bob", address: "bob.private@example.com", allowedCompanies: [BOBS_PERSONAL] },
      {
        key: "shared",
        address: "ops@example.com",
        allowedCompanies: ["*", BOBS_PERSONAL],
        ingestCompanyId: BOBS_PERSONAL,
      },
      { key: "both", address: "both@example.com", allowedCompanies: [OTHER, MINE] },
      { key: "unused", address: "unused@example.com", allowedCompanies: [] },
    ],
  };

  function saveAs(viewer: ConfigViewer, edit: (copy: Record<string, any>) => void = () => {}) {
    const copy = structuredClone(pluginConfigVisibleTo(EMAIL_CONFIG, EMAIL_SCHEMA, viewer)) as Record<string, any>;
    edit(copy);
    return keepUnseenParts(EMAIL_CONFIG, copy, EMAIL_SCHEMA, viewer);
  }

  it("gives back exactly the stored config when a copy is saved as it came", () => {
    expect(saveAs(VIEWER)).toEqual(EMAIL_CONFIG);
    expect(saveAs(ADMIN)).toEqual(EMAIL_CONFIG);
  });

  it("applies an admin's changes and keeps someone else's Personal parts", () => {
    const saved = saveAs(ADMIN, (copy) => {
      copy.pollSeconds = 30;
      const mailboxes = copy.mailboxes as Array<Record<string, unknown>>;
      mailboxes.find((mailbox) => mailbox.key === "shared")!.address = "support@example.com";
      copy.mailboxes = mailboxes.filter((mailbox) => mailbox.key !== "both");
      copy.mailboxes.push({ key: "new", address: "new@example.com", allowedCompanies: [MINE] });
    });

    expect(saved).toEqual({
      pollSeconds: 30,
      alertCompanyId: BOBS_PERSONAL,
      mailboxes: [
        EMAIL_CONFIG.mailboxes[0],
        EMAIL_CONFIG.mailboxes[1],
        {
          key: "shared",
          address: "support@example.com",
          allowedCompanies: ["*", BOBS_PERSONAL],
          ingestCompanyId: BOBS_PERSONAL,
        },
        EMAIL_CONFIG.mailboxes[4],
        { key: "new", address: "new@example.com", allowedCompanies: [MINE] },
      ],
    });
  });

  it("puts parts back into the entry they came from, found by its key", () => {
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
              routes: {
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
    const stored = {
      accounts: [
        { key: "other", allowedCompanies: [OTHER] },
        {
          key: "support",
          allowedCompanies: ["*"],
          routes: [
            { mailboxId: "100", companyId: MINE },
            { mailboxId: "200", companyId: OTHER },
          ],
        },
      ],
    };
    const copy = structuredClone(pluginConfigVisibleTo(stored, schema, VIEWER)) as { accounts: any[] };
    copy.accounts[0].routes[0].mailboxId = "101";

    expect(keepUnseenParts(stored, copy, schema, VIEWER)).toEqual({
      accounts: [
        { key: "other", allowedCompanies: [OTHER] },
        {
          key: "support",
          allowedCompanies: ["*"],
          routes: [
            { mailboxId: "101", companyId: MINE },
            { mailboxId: "200", companyId: OTHER },
          ],
        },
      ],
    });
  });

  it("refuses to guess where an entry with no key or id went once it was changed", () => {
    const schema = {
      type: "object",
      properties: {
        teams: {
          type: "array",
          items: { type: "object", properties: { label: { type: "string" }, companies: companyIds } },
        },
      },
    };
    const stored = { teams: [{ label: "Sales", companies: [MINE, OTHER] }] };
    const copy = structuredClone(pluginConfigVisibleTo(stored, schema, VIEWER)) as { teams: any[] };

    expect(keepUnseenParts(stored, copy, schema, VIEWER)).toEqual(stored);

    copy.teams[0].label = "Sales team";
    expect(() => keepUnseenParts(stored, copy, schema, VIEWER)).toThrow(
      expect.objectContaining({ status: 409 }),
    );
  });

  it("refuses a new entry named like one the copy left out", () => {
    expect(() =>
      saveAs(ADMIN, (copy) => {
        copy.mailboxes.push({ key: "bob", address: "someone@example.com", allowedCompanies: [MINE] });
      }),
    ).toThrow(expect.objectContaining({ status: 409, message: expect.stringContaining('the key "bob"') }));
  });

  it("lets a copy that left nothing out replace everything", () => {
    const everything: ConfigViewer = { ...ADMIN, canSeeCompany: () => true };

    expect(keepUnseenParts(EMAIL_CONFIG, { pollSeconds: 5, mailboxes: [] }, EMAIL_SCHEMA, everything)).toEqual({
      pollSeconds: 5,
      mailboxes: [],
    });
  });
});
