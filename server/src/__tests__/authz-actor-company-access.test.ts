import { beforeEach, describe, expect, it } from "vitest";
import { assertActorCompanyAccess, assertCompanyAccess, hasActorCompanyAccess } from "../routes/authz.js";
import { loadPersonalCompanyIndex, rememberPersonalCompany } from "../services/personal-companies.js";

/**
 * `assertActorCompanyAccess` is the web app's company access rule without an
 * HTTP request around it, for a user acting through a paired chat app (a
 * Slack approve button, for example). It must give the same answer as the
 * request version for the same actor and method, so a chat app can never do
 * more than the web app would let that user do.
 */

const ALICE = "user-alice";
const SHARED = "company-shared";
const OTHER = "company-other";
const BOB_PERSONAL = "company-bob-personal";

type Actor = Express.Request["actor"];

function boardActor(overrides: Partial<Actor> = {}): Actor {
  return {
    type: "board",
    userId: ALICE,
    source: "channel_link",
    companyIds: [SHARED],
    memberships: [{ companyId: SHARED, membershipRole: "member", status: "active" }],
    isInstanceAdmin: false,
    ...overrides,
  };
}

function viaRequest(actor: Actor, method: string, companyId: string): boolean {
  try {
    assertCompanyAccess({ actor, method } as Express.Request, companyId);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  await loadPersonalCompanyIndex({
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
  } as never);
  rememberPersonalCompany(BOB_PERSONAL, "user-bob");
});

describe("assertActorCompanyAccess", () => {
  it("lets an active member make changes in their company", () => {
    expect(() => assertActorCompanyAccess(boardActor(), SHARED, "write", "POST")).not.toThrow();
  });

  it("refuses a viewer a change, as the web app does for a POST", () => {
    const viewer = boardActor({
      memberships: [{ companyId: SHARED, membershipRole: "viewer", status: "active" }],
    });
    expect(() => assertActorCompanyAccess(viewer, SHARED, "write", "POST")).toThrow("Viewer access is read-only");
    // Reading is still fine for a viewer.
    expect(() => assertActorCompanyAccess(viewer, SHARED, "write", "GET")).not.toThrow();
  });

  it("refuses an instance admin a company they are not a member of", () => {
    const admin = boardActor({ isInstanceAdmin: true, companyIds: [], memberships: [] });
    expect(() => assertActorCompanyAccess(admin, OTHER, "write", "POST")).toThrow(
      "User does not have access to this company",
    );
  });

  it("refuses an instance admin someone else's Personal company", () => {
    const admin = boardActor({ isInstanceAdmin: true, companyIds: [BOB_PERSONAL] });
    expect(() => assertActorCompanyAccess(admin, BOB_PERSONAL, "write", "POST")).toThrow(
      "This is someone's personal company",
    );
  });

  it("does not let the portfolio-root read pass stand in for a change", () => {
    const hqAdmin = boardActor({ isPortfolioRootUserAdmin: true });
    expect(() => assertActorCompanyAccess(hqAdmin, OTHER, "write", "POST")).toThrow();
    expect(() => assertActorCompanyAccess(hqAdmin, OTHER, "read", "GET")).not.toThrow();
  });

  it("gives the same answer as the request version for every case above", () => {
    const actors = [
      boardActor(),
      boardActor({ memberships: [{ companyId: SHARED, membershipRole: "viewer", status: "active" }] }),
      boardActor({ isInstanceAdmin: true, companyIds: [], memberships: [] }),
      boardActor({ isPortfolioRootUserAdmin: true }),
    ];
    for (const actor of actors) {
      for (const companyId of [SHARED, OTHER, BOB_PERSONAL]) {
        for (const method of ["GET", "POST"]) {
          expect(hasActorCompanyAccess(actor, companyId, "write", method)).toBe(viaRequest(actor, method, companyId));
        }
      }
    }
  });

  it("refuses an unauthenticated actor", () => {
    expect(() => assertActorCompanyAccess({ type: "none", source: "none" }, SHARED)).toThrow();
  });
});
