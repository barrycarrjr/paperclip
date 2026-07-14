import { beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies } from "@paperclipai/db";
import { portfolioDirectiveService, type DirectiveActor } from "../services/portfolio-directive.ts";

// ── Mocked collaborators ────────────────────────────────────────────────
const mockCreate = vi.hoisted(() => vi.fn());
const mockWakeup = vi.hoisted(() => vi.fn());

vi.mock("../services/issues.js", () => ({
  issueService: vi.fn(() => ({ create: mockCreate })),
}));
vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: vi.fn(() => ({ __heartbeat: true })),
}));
vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: mockWakeup,
}));

type CompanyRow = { id: string; name: string; status: string; isPortfolioRoot: boolean };
type AgentRow = { id: string; name: string; role?: string; status?: string; reportsTo?: string | null };

/**
 * Minimal drizzle-shaped stub. `.from(companies)` resolves to the company
 * rows; `.from(agents)` resolves to the CEO rows when `.limit()` was called
 * (the role='ceo' query) and to the full roster otherwise (the root
 * fallback). Same rows for every company — enough for these scenarios.
 */
function makeDb(opts: { companies: CompanyRow[]; ceo: AgentRow[]; roster: AgentRow[] }) {
  function companiesQuery() {
    const q: Record<string, unknown> = {};
    q.where = () => q;
    q.orderBy = () => q;
    q.limit = () => q;
    (q as { then: unknown }).then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(opts.companies).then(res, rej);
    return q;
  }
  function agentsQuery() {
    let limited = false;
    const q: Record<string, unknown> = {};
    q.where = () => q;
    q.orderBy = () => q;
    q.limit = () => {
      limited = true;
      return q;
    };
    (q as { then: unknown }).then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(limited ? opts.ceo : opts.roster).then(res, rej);
    return q;
  }
  return {
    select: () => ({
      from: (table: unknown) => (table === companies ? companiesQuery() : table === agents ? agentsQuery() : companiesQuery()),
    }),
  } as never;
}

const ADMIN: DirectiveActor = { userId: "user-1", isInstanceAdmin: true, companyIds: [] };

beforeEach(() => {
  mockCreate.mockReset();
  mockWakeup.mockReset();
  mockCreate.mockImplementation(async (companyId: string) => ({
    id: `issue-${companyId}`,
    identifier: `AB-${companyId}`,
    assigneeAgentId: "ceo-1",
    status: "todo",
  }));
  mockWakeup.mockResolvedValue(undefined);
});

describe("portfolioDirectiveService.broadcast", () => {
  it("fans out to each operating company's CEO, wakes them, and skips HQ by default", async () => {
    const db = makeDb({
      companies: [
        { id: "c1", name: "Acme", status: "active", isPortfolioRoot: false },
        { id: "c2", name: "Globex", status: "active", isPortfolioRoot: false },
        { id: "hq", name: "HQ", status: "active", isPortfolioRoot: true },
      ],
      ceo: [{ id: "ceo-1", name: "Chief" }],
      roster: [{ id: "ceo-1", name: "Chief", reportsTo: null }],
    });

    const result = await portfolioDirectiveService(db).broadcast({
      actor: ADMIN,
      intent: "Acknowledge and reply to every company's Google reviews",
    });

    expect(result.dispatched.map((d) => d.companyId).sort()).toEqual(["c1", "c2"]);
    expect(result.dispatched.every((d) => d.ceoAgentId === "ceo-1")).toBe(true);
    // HQ excluded silently (not in dispatched, not surfaced as a skip).
    expect(result.skipped).toHaveLength(0);
    // Real issue-create path used, seeded todo + assigned, tagged with the directive id.
    expect(mockCreate).toHaveBeenCalledTimes(2);
    const [, createArg] = mockCreate.mock.calls[0]!;
    expect(createArg).toMatchObject({
      status: "todo",
      assigneeAgentId: "ceo-1",
      originKind: "portfolio_directive",
      originId: result.directiveId,
    });
    // Each dispatch actually wakes the assignee.
    expect(mockWakeup).toHaveBeenCalledTimes(2);
    expect(result.title).toMatch(/^Directive:/);
  });

  it("skips a company with no CEO or top-level agent", async () => {
    const db = makeDb({
      companies: [{ id: "c1", name: "Acme", status: "active", isPortfolioRoot: false }],
      ceo: [],
      roster: [{ id: "a1", name: "IC", reportsTo: "someone" }], // no root, no ceo
    });

    const result = await portfolioDirectiveService(db).broadcast({
      actor: ADMIN,
      intent: "Do the thing",
    });

    expect(result.dispatched).toHaveLength(0);
    expect(result.skipped).toEqual([
      { companyId: "c1", companyName: "Acme", reason: "No CEO or top-level agent to delegate to" },
    ]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("skips companies the board user can't write to", async () => {
    const db = makeDb({
      companies: [
        { id: "c1", name: "Acme", status: "active", isPortfolioRoot: false },
        { id: "c2", name: "Globex", status: "active", isPortfolioRoot: false },
      ],
      ceo: [{ id: "ceo-1", name: "Chief" }],
      roster: [{ id: "ceo-1", name: "Chief", reportsTo: null }],
    });
    const limitedActor: DirectiveActor = {
      userId: "user-2",
      isInstanceAdmin: false,
      companyIds: ["c1"], // member of c1 only
    };

    const result = await portfolioDirectiveService(db).broadcast({
      actor: limitedActor,
      intent: "Do the thing",
      companyIds: ["c1", "c2"],
    });

    expect(result.dispatched.map((d) => d.companyId)).toEqual(["c1"]);
    expect(result.skipped).toEqual([
      {
        companyId: "c2",
        companyName: "Globex",
        reason: "No write access — you are not a member of this company",
      },
    ]);
  });
});
