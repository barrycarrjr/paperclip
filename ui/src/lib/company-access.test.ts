import { describe, expect, it } from "vitest";
import type { CurrentBoardAccess } from "../api/access";
import { canWriteCompany } from "./company-access";

const COMPANY = "company-1";
const OTHER_COMPANY = "company-2";

function access(overrides: Partial<CurrentBoardAccess> = {}): CurrentBoardAccess {
  return {
    user: { id: "user-1", email: "person@example.com", name: "Person", image: null },
    userId: "user-1",
    isInstanceAdmin: false,
    companyIds: [COMPANY],
    memberships: [{ companyId: COMPANY, membershipRole: "member", status: "active" }],
    source: "session",
    keyId: null,
    ...overrides,
  };
}

describe("canWriteCompany", () => {
  it("true for local_implicit and instance admins", () => {
    expect(
      canWriteCompany(COMPANY, access({ source: "local_implicit", memberships: [], companyIds: [] })),
    ).toBe(true);
    expect(
      canWriteCompany(
        COMPANY,
        access({
          isInstanceAdmin: true,
          memberships: [{ companyId: COMPANY, membershipRole: "viewer", status: "active" }],
        }),
      ),
    ).toBe(true);
  });

  it("true for an active membership with a real, non-viewer role", () => {
    expect(canWriteCompany(COMPANY, access())).toBe(true);
    expect(
      canWriteCompany(
        COMPANY,
        access({ memberships: [{ companyId: COMPANY, membershipRole: "admin", status: "active" }] }),
      ),
    ).toBe(true);
  });

  it("false for an active viewer membership", () => {
    expect(
      canWriteCompany(
        COMPANY,
        access({ memberships: [{ companyId: COMPANY, membershipRole: "viewer", status: "active" }] }),
      ),
    ).toBe(false);
  });

  it("false for an active membership with a null role", () => {
    expect(
      canWriteCompany(
        COMPANY,
        access({ memberships: [{ companyId: COMPANY, membershipRole: null, status: "active" }] }),
      ),
    ).toBe(false);
  });

  it("false for a suspended membership", () => {
    // The company is still listed in companyIds, but memberships is present, so the
    // companyIds fallback must not rescue a suspended member.
    expect(
      canWriteCompany(
        COMPANY,
        access({
          memberships: [{ companyId: COMPANY, membershipRole: "admin", status: "suspended" }],
        }),
      ),
    ).toBe(false);
  });

  it("false for a membership in a different company", () => {
    expect(
      canWriteCompany(
        OTHER_COMPANY,
        access({ companyIds: [COMPANY, OTHER_COMPANY] }),
      ),
    ).toBe(false);
  });

  it("falls back to companyIds when memberships is absent", () => {
    expect(canWriteCompany(COMPANY, access({ memberships: undefined }))).toBe(true);
    expect(canWriteCompany(OTHER_COMPANY, access({ memberships: undefined }))).toBe(false);
  });

  it("false when boardAccess is undefined", () => {
    expect(canWriteCompany(COMPANY, undefined)).toBe(false);
  });
});
