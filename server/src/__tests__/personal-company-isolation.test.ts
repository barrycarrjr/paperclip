import { beforeEach, describe, expect, it } from "vitest";
import type { Request } from "express";
import { assertCompanyAccess } from "../routes/authz.js";
import {
  assertNotPersonalCompany,
  assertPersonalCompanyOwner,
  excludeOthersPersonalCompanies,
  isPersonalCompany,
  loadPersonalCompanyIndex,
  personalCompanyOwner,
  rememberPersonalCompany,
} from "../services/personal-companies.js";

/**
 * Personal companies are private to one person. The promise only holds if it
 * holds against every route into a company, including the two that exist
 * specifically to reach across company lines for HQ roll-ups, and including
 * being an instance administrator.
 *
 * These tests are the statement of that promise.
 */

const ALICE = "user-alice";
const BOB = "user-bob";
const ALICE_PERSONAL = "company-alice-personal";
const SHARED = "company-shared";
const HQ = "company-hq";

function req(actor: Record<string, unknown>): Request {
  return { actor, method: "GET" } as unknown as Request;
}

beforeEach(async () => {
  // Reset the index, then register just Alice's personal company.
  await loadPersonalCompanyIndex({
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
  } as never);
  rememberPersonalCompany(ALICE_PERSONAL, ALICE);
});

describe("personal company index", () => {
  it("knows who owns a personal company and says nothing about others", () => {
    expect(personalCompanyOwner(ALICE_PERSONAL)).toBe(ALICE);
    expect(personalCompanyOwner(SHARED)).toBeNull();
  });
});

describe("who can reach a personal company", () => {
  it("lets the owner in", () => {
    expect(() =>
      assertCompanyAccess(
        req({ type: "board", userId: ALICE, source: "session", companyIds: [ALICE_PERSONAL] }),
        ALICE_PERSONAL,
      ),
    ).not.toThrow();
  });

  it("keeps another user out, even with a membership row", () => {
    // The membership row is the thing an administrator would create to
    // "share" it. It must not be enough.
    expect(() =>
      assertCompanyAccess(
        req({
          type: "board",
          userId: BOB,
          source: "session",
          companyIds: [ALICE_PERSONAL],
          memberships: [{ companyId: ALICE_PERSONAL, status: "active", membershipRole: "owner" }],
        }),
        ALICE_PERSONAL,
        "read",
      ),
    ).toThrow(/personal company/i);
  });

  it("keeps an instance administrator out", () => {
    // Deliberate: an administrator can reset an account but cannot look
    // inside it. A back door only admins can use is still a back door.
    expect(() =>
      assertCompanyAccess(
        req({
          type: "board",
          userId: BOB,
          source: "session",
          isInstanceAdmin: true,
          companyIds: [ALICE_PERSONAL],
        }),
        ALICE_PERSONAL,
        "read",
      ),
    ).toThrow(/personal company/i);
  });

  it("keeps a portfolio-root user admin out", () => {
    // This is the bypass that exists so HQ can read across companies for
    // roll-ups. It must not reach Personal.
    expect(() =>
      assertCompanyAccess(
        req({
          type: "board",
          userId: BOB,
          source: "session",
          companyIds: [HQ],
          isPortfolioRootUserAdmin: true,
        }),
        ALICE_PERSONAL,
        "read",
      ),
    ).toThrow(/personal company/i);
  });

  it("keeps a portfolio-root AGENT out", () => {
    // The same bypass on the agent side — an HQ agent doing a cross-company
    // brief would otherwise read everyone's Personal.
    expect(() =>
      assertCompanyAccess(
        req({ type: "agent", agentId: "a1", companyId: HQ, isPortfolioRootAgent: true }),
        ALICE_PERSONAL,
        "read",
      ),
    ).toThrow(/personal company/i);
  });

  it("still lets an agent that lives IN the personal company work", () => {
    // The owner's own staff. Without this, Personal would have agents that
    // cannot touch their own company.
    expect(() =>
      assertCompanyAccess(
        req({ type: "agent", agentId: "a2", companyId: ALICE_PERSONAL }),
        ALICE_PERSONAL,
        "write",
      ),
    ).not.toThrow();
  });

  it("lets the owner's own Clippy session in, but not someone else's", () => {
    expect(() =>
      assertCompanyAccess(
        req({ type: "tool_session", userId: ALICE, companyId: ALICE_PERSONAL }),
        ALICE_PERSONAL,
      ),
    ).not.toThrow();

    expect(() =>
      assertCompanyAccess(
        req({ type: "tool_session", userId: BOB, companyId: ALICE_PERSONAL }),
        ALICE_PERSONAL,
      ),
    ).toThrow(/personal company/i);
  });

  it("lets the single local operator in", () => {
    // A local_trusted install has one person and a synthetic actor id, so
    // there is nobody to be isolated from — and the owner must not be locked
    // out of their own Personal on their own machine.
    expect(() =>
      assertCompanyAccess(
        req({ type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true }),
        ALICE_PERSONAL,
      ),
    ).not.toThrow();
  });

  it("does not change how ordinary companies behave", () => {
    expect(() =>
      assertCompanyAccess(
        req({ type: "board", userId: BOB, source: "session", companyIds: [SHARED], memberships: [] }),
        SHARED,
        "read",
      ),
    ).not.toThrow();

    expect(() =>
      assertCompanyAccess(
        req({ type: "board", userId: BOB, source: "session", companyIds: [], memberships: [] }),
        SHARED,
        "read",
      ),
    ).toThrow(/does not have access/i);
  });
});

describe("the same personal company under another spelling", () => {
  // Real company ids are uuids, and Postgres reads every one of these as the
  // same company. The index has to as well, or the check above is one
  // rewritten id away from letting HQ in.
  const ALICE_UUID = "c0ffee00-beef-4dad-b0b0-facade123456";
  const digits = ALICE_UUID.replace(/-/g, "");
  const spellings: Array<[string, string]> = [
    ["in capitals", ALICE_UUID.toUpperCase()],
    ["without hyphens", digits],
    ["in braces", `{${ALICE_UUID}}`],
    ["with a hyphen after every four digits", digits.match(/.{4}/g)!.join("-")],
  ];

  beforeEach(() => {
    rememberPersonalCompany(ALICE_UUID, ALICE);
  });

  it.each(spellings)("is still Alice's to every lookup when written %s", (_how, spelling) => {
    expect(personalCompanyOwner(spelling)).toBe(ALICE);
    expect(isPersonalCompany(spelling)).toBe(true);
    expect(() => assertPersonalCompanyOwner(spelling, BOB)).toThrow(/personal company/i);
    expect(() => assertPersonalCompanyOwner(spelling, ALICE)).not.toThrow();
    expect(() => assertNotPersonalCompany(spelling, "add a member")).toThrow(/personal company/i);
    expect(excludeOthersPersonalCompanies([{ id: spelling }], BOB)).toEqual([]);
  });

  it.each(spellings)("keeps an HQ agent and an HQ admin out when written %s", (_how, spelling) => {
    expect(() =>
      assertCompanyAccess(
        req({ type: "agent", agentId: "a1", companyId: HQ, isPortfolioRootAgent: true }),
        spelling,
        "read",
      ),
    ).toThrow(/personal company/i);
    expect(() =>
      assertCompanyAccess(
        req({ type: "board", userId: BOB, source: "session", companyIds: [HQ], isPortfolioRootUserAdmin: true }),
        spelling,
        "read",
      ),
    ).toThrow(/personal company/i);
  });
});
