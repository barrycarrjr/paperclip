import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { companyRoutes } from "../routes/companies.js";
import { loadPersonalCompanyIndex, rememberPersonalCompany } from "../services/personal-companies.js";

const mockCompanyService = vi.hoisted(() => ({
  stats: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({}),
  agentService: () => ({}),
  budgetService: () => ({}),
  companyPortabilityService: () => ({}),
  companyService: () => mockCompanyService,
  logActivity: vi.fn(),
}));

/**
 * The per-company counts behind the company switcher. HQ reads them across
 * every company, which is exactly why someone's Personal has to be taken out:
 * its issue count alone says more than "you cannot see anything in my
 * personal", as the company list route already puts it.
 */

const ALICE = "user-alice";
const BOB = "user-bob";
const CAROL = "user-carol";
const HQ = "company-hq";
const ACME = "company-acme";
const ALICE_PERSONAL = "company-alice-personal";

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { actor: Record<string, unknown> }).actor = actor;
    next();
  });
  app.use("/api/companies", companyRoutes({} as never));
  app.use(errorHandler);
  return app;
}

async function statsSeenBy(actor: Record<string, unknown>) {
  const res = await request(createApp(actor)).get("/api/companies/stats");
  expect(res.status).toBe(200);
  return Object.keys(res.body as Record<string, unknown>).sort();
}

beforeEach(async () => {
  // Reset the index, then register just Alice's personal company.
  await loadPersonalCompanyIndex({
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
  } as never);
  rememberPersonalCompany(ALICE_PERSONAL, ALICE);
  mockCompanyService.stats.mockResolvedValue({
    [HQ]: { agentCount: 1, issueCount: 2 },
    [ACME]: { agentCount: 3, issueCount: 40 },
    [ALICE_PERSONAL]: { agentCount: 2, issueCount: 17 },
  });
});

describe("GET /api/companies/stats", () => {
  it("leaves someone's Personal out for an HQ agent", async () => {
    expect(
      await statsSeenBy({ type: "agent", agentId: "a1", companyId: HQ, isPortfolioRootAgent: true, source: "agent_key" }),
    ).toEqual([ACME, HQ].sort());
  });

  it("leaves someone's Personal out for an HQ admin who is not the owner", async () => {
    expect(
      await statsSeenBy({
        type: "board",
        userId: BOB,
        source: "session",
        companyIds: [HQ],
        memberships: [{ companyId: HQ, status: "active", membershipRole: "owner" }],
        isPortfolioRootUserAdmin: true,
      }),
    ).toEqual([ACME, HQ].sort());
  });

  it("leaves someone's Personal out for an instance administrator", async () => {
    expect(
      await statsSeenBy({ type: "board", userId: CAROL, source: "session", companyIds: [], isInstanceAdmin: true }),
    ).toEqual([ACME, HQ].sort());
  });

  it("leaves someone's Personal out even for a member with a row on it", async () => {
    // A membership row is what would make it look shared. It must not be enough.
    expect(
      await statsSeenBy({ type: "board", userId: BOB, source: "session", companyIds: [ACME, ALICE_PERSONAL] }),
    ).toEqual([ACME]);
  });

  it("still shows the owner her own Personal", async () => {
    expect(
      await statsSeenBy({
        type: "board",
        userId: ALICE,
        source: "session",
        companyIds: [HQ, ALICE_PERSONAL],
        isPortfolioRootUserAdmin: true,
      }),
    ).toEqual([ACME, ALICE_PERSONAL, HQ].sort());
  });

  it("still shows the single local operator everything, as the company list does", async () => {
    expect(
      await statsSeenBy({ type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true }),
    ).toEqual([ACME, ALICE_PERSONAL, HQ].sort());
  });
});
