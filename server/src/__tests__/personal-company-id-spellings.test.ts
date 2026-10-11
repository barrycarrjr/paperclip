import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, companyMemberships, createDb, issues } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { dashboardRoutes } from "../routes/dashboard.js";
import { issueRoutes } from "../routes/issues.js";
import { accessService } from "../services/access.js";
import { executeChatTool } from "../services/chat-tools.js";
import { loadPersonalCompanyIndex, personalCompanyOwner } from "../services/personal-companies.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Personal company id spelling tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * Postgres reads a company id written in capitals, in braces, without hyphens
 * or with the hyphens moved as the same company. The Personal check must too:
 * otherwise someone else's Personal is one rewritten id away for exactly the
 * people the check exists to keep out.
 */

type Actor = Express.Request["actor"];

const ALICE = "user-alice";
const BOB = "user-bob";
const CAROL = "user-carol";
const HQ = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const ACME = "5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9";
const ALICE_PERSONAL = "c0ffee00-beef-4dad-b0b0-facade123456";
const HQ_AGENT = "d4c3b2a1-f6e5-4d7c-9b8a-1f2e3d4c5b6a";
const ALICE_SECRET = "Alice's private plans";

/** The same id, written the other ways Postgres reads as the same company. */
function otherSpellings(id: string): Array<[string, string]> {
  const digits = id.replace(/-/g, "");
  return [
    ["in capitals", id.toUpperCase()],
    ["without hyphens", digits],
    ["in braces", `{${id}}`],
    ["with a hyphen after every four digits", digits.match(/.{4}/g)!.join("-")],
  ];
}

const hqAgent: Actor = {
  type: "agent",
  agentId: HQ_AGENT,
  companyId: HQ,
  isPortfolioRootAgent: true,
  source: "agent_key",
};

const hqAdminNotOwner: Actor = {
  type: "board",
  userId: BOB,
  source: "session",
  companyIds: [HQ],
  memberships: [{ companyId: HQ, membershipRole: "owner", status: "active" }],
  isInstanceAdmin: false,
  isPortfolioRootUserAdmin: true,
};

const nonOwners: Array<[string, Actor]> = [
  ["an HQ agent", hqAgent],
  ["an HQ admin who is not the owner", hqAdminNotOwner],
];

describeEmbeddedPostgres("someone's Personal company, whatever way its id is written", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-personal-id-spellings-");
    db = createDb(tempDb.connectionString);

    // The migrations seed an HQ company of their own, and there can only be one.
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);

    await db.insert(companies).values([
      { id: HQ, name: "HQ", issuePrefix: "HQS", isPortfolioRoot: true },
      { id: ACME, name: "Acme", issuePrefix: "ACS" },
      { id: ALICE_PERSONAL, name: "Personal", issuePrefix: "MES", kind: "personal", ownerUserId: ALICE },
    ]);
    await db.insert(agents).values({ id: HQ_AGENT, companyId: HQ, name: "HQ analyst" });
    await db.insert(issues).values([
      { companyId: ALICE_PERSONAL, title: ALICE_SECRET, status: "todo", priority: "medium" },
      { companyId: ACME, title: "Acme launch", status: "todo", priority: "medium" },
    ]);

    await loadPersonalCompanyIndex(db);
  }, 90_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Actor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use("/api", dashboardRoutes(db));
    app.use(errorHandler);
    return app;
  }

  const companyPath = (companyId: string, rest: string) =>
    `/api/companies/${encodeURIComponent(companyId)}/${rest}`;

  async function issueTitlesIn(companyId: string): Promise<string[]> {
    const rows = await db.select({ title: issues.title }).from(issues).where(eq(issues.companyId, companyId));
    return rows.map((row) => row.title);
  }

  it("is recognised by the Personal index under every spelling Postgres reads as that company", async () => {
    const digits = ALICE_PERSONAL.replace(/-/g, "");
    const candidates = [
      ...otherSpellings(ALICE_PERSONAL).map(([, spelling]) => spelling),
      `{${ALICE_PERSONAL.toUpperCase()}}`,
      `{${digits}}`,
      digits.toUpperCase(),
      ` ${ALICE_PERSONAL}`,
      `${ALICE_PERSONAL} `,
      `${ALICE_PERSONAL}\n`,
      `{${ALICE_PERSONAL}`,
      `${ALICE_PERSONAL}}`,
      ALICE_PERSONAL.replace(/-/g, "--"),
      `-${digits}`,
      `${digits}-`,
      `urn:uuid:${ALICE_PERSONAL}`,
    ];

    const readAsAlicesPersonal: string[] = [];
    for (const candidate of candidates) {
      let rows: Array<{ id: string }> = [];
      try {
        rows = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, candidate));
      } catch {
        // Postgres does not read it as a uuid at all, so it reaches no company.
        continue;
      }
      if (rows.some((row) => row.id === ALICE_PERSONAL)) readAsAlicesPersonal.push(candidate);
    }

    // The test means nothing unless Postgres really does take the other forms.
    expect(readAsAlicesPersonal).toEqual(
      expect.arrayContaining(otherSpellings(ALICE_PERSONAL).map(([, spelling]) => spelling)),
    );
    for (const spelling of readAsAlicesPersonal) {
      expect(personalCompanyOwner(spelling), JSON.stringify(spelling)).toBe(ALICE);
    }
  });

  describe("through the REST routes", () => {
    describe.each(nonOwners)("for %s", (_who, actor) => {
      it.each(otherSpellings(ALICE_PERSONAL))("refuses the issue list with the id %s", async (_how, spelling) => {
        const res = await request(createApp(actor)).get(companyPath(spelling, "issues"));
        expect(res.status).toBe(403);
        expect(JSON.stringify(res.body)).not.toContain(ALICE_SECRET);
      });

      it.each(otherSpellings(ALICE_PERSONAL))("refuses the dashboard with the id %s", async (_how, spelling) => {
        const res = await request(createApp(actor)).get(companyPath(spelling, "dashboard"));
        expect(res.status).toBe(403);
        expect(res.body).not.toHaveProperty("tasks");
      });

      it("refuses the id written normally, as before", async () => {
        const res = await request(createApp(actor)).get(companyPath(ALICE_PERSONAL, "issues"));
        expect(res.status).toBe(403);
      });

      it("still reads an ordinary company whose id is written in capitals", async () => {
        const res = await request(createApp(actor)).get(companyPath(ACME.toUpperCase(), "issues"));
        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).toContain("Acme launch");
      });
    });
  });

  describe("through Clippy, for an instance administrator who is not the owner", () => {
    const clippy = () => ({
      db,
      actor: { userId: CAROL, isInstanceAdmin: true, companyIds: [] },
      defaultCompanyId: null,
    });

    it.each(otherSpellings(ALICE_PERSONAL))("list_issues refuses the id %s", async (_how, spelling) => {
      const result = await executeChatTool("list_issues", { companyId: spelling }, clippy());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/personal company/i);
      expect(JSON.stringify(result)).not.toContain(ALICE_SECRET);
    });

    it.each(otherSpellings(ALICE_PERSONAL))("create_issue refuses the id %s and creates nothing", async (_how, spelling) => {
      const result = await executeChatTool(
        "create_issue",
        { companyId: spelling, title: "Planted by an admin" },
        clippy(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/personal company/i);
      expect(await issueTitlesIn(ALICE_PERSONAL)).toEqual([ALICE_SECRET]);
    });
  });

  describe("through company access administration", () => {
    it("will not give someone else a seat in a Personal company named in capitals", async () => {
      // The admin route's uuid check accepts capitals, so this form reaches the service.
      await expect(
        accessService(db).setUserCompanyAccess(BOB, [ALICE_PERSONAL.toUpperCase()], { actorUserId: CAROL }),
      ).rejects.toThrow(/cannot be shared/i);

      const seats = await db
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(and(eq(companyMemberships.companyId, ALICE_PERSONAL), eq(companyMemberships.principalId, BOB)));
      expect(seats).toEqual([]);
    });
  });
});
