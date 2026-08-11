import { beforeEach, describe, expect, it } from "vitest";
import {
  loadPersonalCompanyIndex,
  personalCompanyIds,
  rememberPersonalCompany,
} from "../services/personal-companies.js";

/**
 * Not being able to OPEN someone's Personal is not the whole promise. Its
 * name, and the fact it exists at all, must not show up either — a company
 * list that says "Personal (Alice)" has already told you something.
 *
 * This mirrors the filter in the company list route rather than booting an
 * app, so the rule itself is pinned independently of the routing around it.
 */

const ALICE = "user-alice";
const BOB = "user-bob";
const ALICE_PERSONAL = "company-alice-personal";
const BOB_PERSONAL = "company-bob-personal";
const SHARED = "company-shared";

type Row = { id: string };

/** The same rule the route applies. */
function visibleTo(rows: Row[], viewerUserId: string | null): Row[] {
  const personal = personalCompanyIds();
  return rows.filter((row) => {
    if (!personal.has(row.id)) return true;
    return ownerOf(row.id) === viewerUserId;
  });
}

function ownerOf(companyId: string): string | null {
  return companyId === ALICE_PERSONAL ? ALICE : companyId === BOB_PERSONAL ? BOB : null;
}

beforeEach(async () => {
  await loadPersonalCompanyIndex({
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
  } as never);
  rememberPersonalCompany(ALICE_PERSONAL, ALICE);
  rememberPersonalCompany(BOB_PERSONAL, BOB);
});

describe("company listings", () => {
  const all: Row[] = [{ id: SHARED }, { id: ALICE_PERSONAL }, { id: BOB_PERSONAL }];

  it("shows a user their own Personal and the shared company", () => {
    expect(visibleTo(all, ALICE).map((r) => r.id)).toEqual([SHARED, ALICE_PERSONAL]);
  });

  it("hides other people's Personal entirely, not just its contents", () => {
    const seen = visibleTo(all, BOB).map((r) => r.id);
    expect(seen).toEqual([SHARED, BOB_PERSONAL]);
    expect(seen).not.toContain(ALICE_PERSONAL);
  });

  it("hides every Personal from a viewer with no user identity", () => {
    // An HQ agent doing a cross-company roll-up. It has no user, so no
    // personal company is ever its own.
    expect(visibleTo(all, null).map((r) => r.id)).toEqual([SHARED]);
  });

  it("leaves ordinary companies alone", () => {
    expect(visibleTo([{ id: SHARED }], BOB)).toEqual([{ id: SHARED }]);
  });
});
