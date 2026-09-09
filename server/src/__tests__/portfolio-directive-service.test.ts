import { beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies } from "@paperclipai/db";
import { portfolioDirectiveService, type DirectiveActor } from "../services/portfolio-directive.ts";

// ── Mocked collaborators ────────────────────────────────────────────────
const mockCreate = vi.hoisted(() => vi.fn());
const mockWakeup = vi.hoisted(() => vi.fn());
const mockGetGeneral = vi.hoisted(() => vi.fn());

vi.mock("../services/issues.js", () => ({
  issueService: vi.fn(() => ({ create: mockCreate })),
}));
vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: vi.fn(() => ({ __heartbeat: true })),
}));
vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: mockWakeup,
}));
vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: vi.fn(() => ({ getGeneral: mockGetGeneral })),
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
  mockGetGeneral.mockReset();
  mockGetGeneral.mockResolvedValue({ outboundToolDraftMode: true });
  mockCreate.mockImplementation(async (companyId: string) => ({
    id: `issue-${companyId}`,
    identifier: `AB-${companyId}`,
    assigneeAgentId: "ceo-1",
    status: "todo",
  }));
  mockWakeup.mockResolvedValue(undefined);
});

/**
 * The only way a directive is ever sent: preview it, then send that exact
 * preview. Every existing scenario goes through here because the service
 * refuses a send that no preview answered for.
 */
async function previewThenSend(
  db: Parameters<typeof portfolioDirectiveService>[0],
  input: { actor: DirectiveActor; intent: string; companyIds?: string[]; includePortfolioRoot?: boolean },
) {
  const svc = portfolioDirectiveService(db);
  const preview = await svc.preview(input);
  return svc.broadcast({ ...input, previewId: preview.previewId });
}

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

    const result = await previewThenSend(db, {
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

    const result = await previewThenSend(db, {
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

    const result = await previewThenSend(db, {
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

  it("targets nothing for an explicit empty company selection, rather than falling through to every accessible company", async () => {
    // Regression (P4 audit, 2026-09-03): `companyIds: []` used to be treated
    // identically to "omitted" (`companyIds && companyIds.length > 0` is
    // false either way), so an explicit empty selection silently broadcast
    // to every accessible company instead of targeting none — reachable via
    // the `broadcast_directive` Clippy tool, not just the one first-party
    // form that happens to disable submit on an empty pick.
    const db = makeDb({
      companies: [
        { id: "c1", name: "Acme", status: "active", isPortfolioRoot: false },
        { id: "c2", name: "Globex", status: "active", isPortfolioRoot: false },
      ],
      ceo: [{ id: "ceo-1", name: "Chief" }],
      roster: [{ id: "ceo-1", name: "Chief", reportsTo: null }],
    });

    const result = await previewThenSend(db, {
      actor: ADMIN,
      intent: "Do the thing",
      companyIds: [],
    });

    expect(result.dispatched).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("portfolioDirectiveService.preview", () => {
  const THREE_COMPANIES = {
    companies: [
      { id: "c1", name: "Acme", status: "active", isPortfolioRoot: false },
      { id: "c2", name: "Globex", status: "active", isPortfolioRoot: false },
      { id: "hq", name: "HQ", status: "active", isPortfolioRoot: true },
    ],
    ceo: [{ id: "ceo-1", name: "Chief" }],
    roster: [{ id: "ceo-1", name: "Chief", reportsTo: null }],
  };

  it("names the companies that would get it and who in each one receives it, and creates nothing", async () => {
    const db = makeDb(THREE_COMPANIES);

    const preview = await portfolioDirectiveService(db).preview({
      actor: ADMIN,
      intent: "Acknowledge and reply to every company's Google reviews",
    });

    expect(preview.willReceive).toEqual([
      { companyId: "c1", companyName: "Acme", lead: { id: "ceo-1", name: "Chief" } },
      { companyId: "c2", companyName: "Globex", lead: { id: "ceo-1", name: "Chief" } },
    ]);
    expect(preview.title).toMatch(/^Directive:/);
    expect(preview.previewId).toMatch(/^[0-9a-f]{64}$/);

    // The whole point: asking what would happen must not make any of it
    // happen. No issue written, nobody woken.
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("gives the service's own skip reasons rather than inventing them", async () => {
    const db = makeDb({
      companies: [
        { id: "c1", name: "Acme", status: "active", isPortfolioRoot: false },
        { id: "c2", name: "Globex", status: "archived", isPortfolioRoot: false },
      ],
      ceo: [{ id: "ceo-1", name: "Chief" }],
      roster: [{ id: "ceo-1", name: "Chief", reportsTo: null }],
    });

    const preview = await portfolioDirectiveService(db).preview({
      actor: { userId: "user-2", isInstanceAdmin: false, companyIds: ["c1"] },
      intent: "Do the thing",
      companyIds: ["c1", "c2"],
    });

    expect(preview.willReceive.map((r) => r.companyId)).toEqual(["c1"]);
    expect(preview.skipped).toEqual([
      { companyId: "c2", companyName: "Globex", reason: "Company is archived" },
    ]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("says in plain words that outbound work waits for approval, and says the opposite when the hold is off", async () => {
    const db = makeDb(THREE_COMPANIES);

    const held = await portfolioDirectiveService(db).preview({ actor: ADMIN, intent: "Do the thing" });
    expect(held.guardrails.outboundHold).toBe(true);
    expect(held.summaryLines).toContain(
      "Emails, messages, calls and public posts the agents draft will wait for your approval first.",
    );
    expect(held.summaryLines).toContain(
      "Creates one request in each of them. Nothing else exists until each lead acts on it.",
    );

    mockGetGeneral.mockResolvedValue({ outboundToolDraftMode: false });
    const open = await portfolioDirectiveService(db).preview({ actor: ADMIN, intent: "Do the thing" });
    expect(open.summaryLines).toContain(
      "The approval hold is switched off, so emails, messages, calls and public posts the agents make will go out without asking you. Change this under Instance settings.",
    );
  });
});

describe("portfolioDirectiveService.broadcast requires the preview it was shown", () => {
  const TWO_COMPANIES = {
    companies: [
      { id: "c1", name: "Acme", status: "active", isPortfolioRoot: false },
      { id: "c2", name: "Globex", status: "active", isPortfolioRoot: false },
    ],
    ceo: [{ id: "ceo-1", name: "Chief" }],
    roster: [{ id: "ceo-1", name: "Chief", reportsTo: null }],
  };

  it("refuses to send with no previewId, and writes nothing", async () => {
    const db = makeDb(TWO_COMPANIES);

    await expect(
      portfolioDirectiveService(db).broadcast({ actor: ADMIN, intent: "Do the thing", previewId: "" }),
    ).rejects.toThrow(/Preview this directive first/);

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("refuses a previewId that was not minted here, and writes nothing", async () => {
    const db = makeDb(TWO_COMPANIES);

    await expect(
      portfolioDirectiveService(db).broadcast({
        actor: ADMIN,
        intent: "Do the thing",
        previewId: "f".repeat(64),
      }),
    ).rejects.toThrow(/Preview it again/);

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("refuses a preview of different words, so a send cannot carry another preview's id", async () => {
    const db = makeDb(TWO_COMPANIES);
    const svc = portfolioDirectiveService(db);
    const preview = await svc.preview({ actor: ADMIN, intent: "Reply to the Google reviews" });

    await expect(
      svc.broadcast({ actor: ADMIN, intent: "Cancel every open order", previewId: preview.previewId }),
    ).rejects.toThrow(/Preview it again/);

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("refuses when the companies changed between the preview and the send, and writes nothing", async () => {
    const previewDb = makeDb(TWO_COMPANIES);
    const preview = await portfolioDirectiveService(previewDb).preview({
      actor: ADMIN,
      intent: "Do the thing",
    });
    expect(preview.willReceive).toHaveLength(2);

    // Globex is archived in the moment between reading and sending. The
    // operator agreed to two companies, so the send stops rather than
    // quietly doing something they never saw.
    const sendDb = makeDb({
      ...TWO_COMPANIES,
      companies: [
        { id: "c1", name: "Acme", status: "active", isPortfolioRoot: false },
        { id: "c2", name: "Globex", status: "archived", isPortfolioRoot: false },
      ],
    });

    await expect(
      portfolioDirectiveService(sendDb).broadcast({
        actor: ADMIN,
        intent: "Do the thing",
        previewId: preview.previewId,
      }),
    ).rejects.toThrow(/Preview it again/);

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("refuses one person's preview id used by another person", async () => {
    const db = makeDb(TWO_COMPANIES);
    const svc = portfolioDirectiveService(db);
    const preview = await svc.preview({ actor: ADMIN, intent: "Do the thing" });

    await expect(
      svc.broadcast({
        actor: { userId: "someone-else", isInstanceAdmin: true, companyIds: [] },
        intent: "Do the thing",
        previewId: preview.previewId,
      }),
    ).rejects.toThrow(/Preview it again/);

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("sends exactly what the preview said, to exactly the leads it named", async () => {
    const db = makeDb(TWO_COMPANIES);
    const svc = portfolioDirectiveService(db);
    const preview = await svc.preview({ actor: ADMIN, intent: "Do the thing" });

    const result = await svc.broadcast({
      actor: ADMIN,
      intent: "Do the thing",
      previewId: preview.previewId,
    });

    expect(result.dispatched.map((d) => `${d.companyId}:${d.ceoAgentId}`)).toEqual(
      preview.willReceive.map((r) => `${r.companyId}:${r.lead.id}`),
    );
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockWakeup).toHaveBeenCalledTimes(2);
  });

  it("leaves nothing behind when the operator previews and then walks away", async () => {
    const db = makeDb(TWO_COMPANIES);
    const svc = portfolioDirectiveService(db);

    await svc.preview({ actor: ADMIN, intent: "Do the thing" });
    await svc.preview({ actor: ADMIN, intent: "Do the thing", companyIds: ["c1"] });
    await svc.preview({ actor: ADMIN, intent: "Something else entirely" });

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockWakeup).not.toHaveBeenCalled();
  });
});
