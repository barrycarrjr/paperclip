import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  issueRelations,
  issues,
} from "@paperclipai/db";
import { claimBoardOwnership, getBoardClaimWarningUrl, initializeBoardClaimChallenge } from "../board-claim.js";
import { errorHandler } from "../middleware/index.js";
import { accessRoutes } from "../routes/access.js";
import { agentRoutes } from "../routes/agents.js";
import { instanceSettingsRoutes } from "../routes/instance-settings.js";
import { loadPersonalCompanyIndex } from "../services/personal-companies.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres admin tool privacy tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// The owner of this instance is an instance admin and owns his own Personal.
// Bob owns another Personal and works in Acme. Carol is an instance admin
// with no seat anywhere.
const OWNER = "user-owner";
const BOB = "user-bob";
const CAROL = "user-carol";

/**
 * An instance admin's tools reach across every company on purpose. Someone's
 * Personal company is still theirs alone, administrators included, so each of
 * these tools stops at it. The owner of this instance keeps everything he had,
 * his own Personal included.
 */
describeEmbeddedPostgres("admin tools and Personal companies", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let acmeId!: string;
  let bobPersonalId!: string;
  let ownerPersonalId!: string;
  const prefixOf: Record<string, string> = {};

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-admin-tools-personal-");
    db = createDb(tempDb.connectionString);
  }, 90_000);

  async function clearTables() {
    await db.delete(activityLog);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(instanceUserRoles);
    await db.delete(companyMemberships);
    // The migrations seed an HQ company of their own.
    await db.delete(companies);
  }

  beforeEach(async () => {
    await clearTables();
    acmeId = randomUUID();
    bobPersonalId = randomUUID();
    ownerPersonalId = randomUUID();
    prefixOf[acmeId] = "ACA";
    prefixOf[bobPersonalId] = "MEA";
    prefixOf[ownerPersonalId] = "ME2A";
    await db.insert(companies).values([
      { id: acmeId, name: "Acme", issuePrefix: prefixOf[acmeId]! },
      { id: bobPersonalId, name: "Personal", issuePrefix: prefixOf[bobPersonalId]!, kind: "personal", ownerUserId: BOB },
      {
        id: ownerPersonalId,
        name: "Personal",
        issuePrefix: prefixOf[ownerPersonalId]!,
        kind: "personal",
        ownerUserId: OWNER,
      },
    ]);
    await db.insert(companyMemberships).values([
      { companyId: bobPersonalId, principalType: "user", principalId: BOB, status: "active", membershipRole: "owner" },
      { companyId: acmeId, principalType: "user", principalId: BOB, status: "active", membershipRole: "operator" },
      {
        companyId: ownerPersonalId,
        principalType: "user",
        principalId: OWNER,
        status: "active",
        membershipRole: "owner",
      },
    ]);
    await db.insert(instanceUserRoles).values([
      { userId: OWNER, role: "instance_admin" },
      { userId: CAROL, role: "instance_admin" },
    ]);
    await loadPersonalCompanyIndex(db);
  });

  afterEach(async () => {
    await clearTables();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // Actors as the sign-in middleware sets them.
  const owner = () => ({
    type: "board",
    userId: OWNER,
    source: "session",
    isInstanceAdmin: true,
    companyIds: [ownerPersonalId],
    memberships: [{ companyId: ownerPersonalId, membershipRole: "owner", status: "active" }],
  });
  const carol = () => ({
    type: "board",
    userId: CAROL,
    source: "session",
    isInstanceAdmin: true,
    companyIds: [],
    memberships: [],
  });

  function app(actor: Record<string, unknown>) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      (req as unknown as { actor: Record<string, unknown> }).actor = actor;
      next();
    });
    instance.use("/api", agentRoutes(db));
    instance.use("/api", instanceSettingsRoutes(db));
    instance.use(
      "/api",
      accessRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        bindHost: "127.0.0.1",
        allowedHostnames: [],
      }),
    );
    instance.use(errorHandler);
    return instance;
  }

  async function seedAgent(companyId: string, name: string) {
    const [agent] = await db
      .insert(agents)
      .values({ companyId, name, status: "idle", forbiddenWritePaths: ["secrets/**"] })
      .returning();
    return agent!;
  }

  async function forbiddenPathsOf(agentId: string) {
    const [row] = await db
      .select({ paths: agents.forbiddenWritePaths })
      .from(agents)
      .where(eq(agents.id, agentId));
    return row?.paths;
  }

  describe("forbidden paths", () => {
    it("are not an instance admin's to change on an agent in someone else's Personal company", async () => {
      const bobs = await seedAgent(bobPersonalId, "Bob's helper");
      const acmes = await seedAgent(acmeId, "Acme helper");

      const refused = await request(app(carol()))
        .patch(`/api/agents/${bobs.id}/forbidden-paths`)
        .send({ paths: [] });
      const allowed = await request(app(carol()))
        .patch(`/api/agents/${acmes.id}/forbidden-paths`)
        .send({ paths: [] });

      expect(refused.status).toBe(403);
      expect(refused.body).toEqual({ error: "This is someone's personal company" });
      expect(await forbiddenPathsOf(bobs.id)).toEqual(["secrets/**"]);
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
      expect(await forbiddenPathsOf(acmes.id)).toEqual([]);
    });

    it("are still the owner's to change on an agent in his own Personal company", async () => {
      const his = await seedAgent(ownerPersonalId, "Owner's helper");

      const res = await request(app(owner()))
        .patch(`/api/agents/${his.id}/forbidden-paths`)
        .send({ paths: ["drafts/**"] });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await forbiddenPathsOf(his.id)).toEqual(["drafts/**"]);
    });
  });

  describe("scheduler heartbeats", () => {
    async function agentsSeenBy(actor: Record<string, unknown>) {
      const res = await request(app(actor)).get("/api/instance/scheduler-heartbeats");
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return (res.body.agents as Array<{ agentName: string }>).map((agent) => agent.agentName).sort();
    }

    it("leave out the agents in someone else's Personal company, and keep the owner's own", async () => {
      await seedAgent(acmeId, "Acme helper");
      await seedAgent(bobPersonalId, "Bob's helper");
      await seedAgent(ownerPersonalId, "Owner's helper");

      expect(await agentsSeenBy(carol())).toEqual(["Acme helper"]);
      expect(await agentsSeenBy(owner())).toEqual(["Acme helper", "Owner's helper"]);
    });
  });

  describe("the issue graph liveness preview", () => {
    // A blocked task whose blocker nobody owns: the shape the preview reports.
    async function seedStuckTask(companyId: string) {
      const managerId = randomUUID();
      const coderId = randomUUID();
      const blockedIssueId = randomUUID();
      const blockerIssueId = randomUUID();
      const prefix = prefixOf[companyId]!;
      const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      await db.insert(agents).values([
        {
          id: managerId,
          companyId,
          name: "CTO",
          role: "cto",
          status: "idle",
          adapterType: "codex_local",
          adapterConfig: {},
          runtimeConfig: { heartbeat: { wakeOnDemand: false } },
          permissions: {},
        },
        {
          id: coderId,
          companyId,
          name: "Coder",
          role: "engineer",
          status: "idle",
          reportsTo: managerId,
          adapterType: "codex_local",
          adapterConfig: {},
          runtimeConfig: { heartbeat: { wakeOnDemand: false } },
          permissions: {},
        },
      ]);
      await db.insert(issues).values([
        {
          id: blockedIssueId,
          companyId,
          title: "Blocked parent",
          status: "blocked",
          priority: "medium",
          assigneeAgentId: coderId,
          issueNumber: 1,
          identifier: `${prefix}-1`,
          createdAt: anHourAgo,
          updatedAt: anHourAgo,
        },
        {
          id: blockerIssueId,
          companyId,
          title: "Missing unblock owner",
          status: "todo",
          priority: "medium",
          issueNumber: 2,
          identifier: `${prefix}-2`,
          createdAt: anHourAgo,
          updatedAt: anHourAgo,
        },
      ]);
      await db.insert(issueRelations).values({
        companyId,
        issueId: blockerIssueId,
        relatedIssueId: blockedIssueId,
        type: "blocks",
      });
    }

    async function previewSeenBy(actor: Record<string, unknown>) {
      const res = await request(app(actor))
        .post("/api/instance/settings/experimental/issue-graph-liveness-auto-recovery/preview")
        .send({ lookbackHours: 24 });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return {
        findings: res.body.findings as number,
        identifiers: (res.body.items as Array<{ identifier: string }>).map((item) => item.identifier).sort(),
      };
    }

    it("leaves out stuck tasks in someone else's Personal company, counts too, and keeps the owner's own", async () => {
      await seedStuckTask(acmeId);
      await seedStuckTask(bobPersonalId);
      await seedStuckTask(ownerPersonalId);

      expect(await previewSeenBy(carol())).toEqual({ findings: 1, identifiers: ["ACA-1"] });
      expect(await previewSeenBy(owner())).toEqual({ findings: 2, identifiers: ["ACA-1", "ME2A-1"] });
    });
  });

  describe("a user's company access, as an admin sees it", () => {
    const companiesIn = (body: { companyAccess: Array<{ companyId: string }> }) =>
      body.companyAccess.map((row) => row.companyId).sort();

    it("leaves out that user's Personal company, before and after a save, and the save keeps it", async () => {
      const seen = await request(app(carol())).get(`/api/admin/users/${BOB}/company-access`);
      const saved = await request(app(carol()))
        .put(`/api/admin/users/${BOB}/company-access`)
        .send({ companyIds: [acmeId] });

      expect(seen.status, JSON.stringify(seen.body)).toBe(200);
      expect(companiesIn(seen.body)).toEqual([acmeId]);
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(companiesIn(saved.body)).toEqual([acmeId]);
      const [kept] = await db
        .select({ status: companyMemberships.status })
        .from(companyMemberships)
        .where(and(eq(companyMemberships.companyId, bobPersonalId), eq(companyMemberships.principalId, BOB)));
      expect(kept?.status).toBe("active");
    });

    it("still shows the owner his own Personal company when he looks at himself", async () => {
      const res = await request(app(owner())).get(`/api/admin/users/${OWNER}/company-access`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(companiesIn(res.body)).toEqual([ownerPersonalId]);
    });
  });

  describe("claiming the board", () => {
    it("gives the claimer a seat in every company but someone else's Personal, his own included", async () => {
      // A claim is on offer only while the local board is the sole instance admin.
      await db.delete(instanceUserRoles);
      await db.insert(instanceUserRoles).values({ userId: "local-board", role: "instance_admin" });
      await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
      const claimUrl = new URL(getBoardClaimWarningUrl("127.0.0.1", 3100)!);
      const token = claimUrl.pathname.split("/").pop()!;
      const code = claimUrl.searchParams.get("code")!;

      const claimed = await claimBoardOwnership(db, { token, code, userId: OWNER });

      expect(claimed.status).toBe("claimed");
      const seats = await db
        .select({ companyId: companyMemberships.companyId, role: companyMemberships.membershipRole })
        .from(companyMemberships)
        .where(and(eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, OWNER)));
      expect(seats.map((seat) => seat.companyId).sort()).toEqual([acmeId, ownerPersonalId].sort());
      expect(seats.every((seat) => seat.role === "owner")).toBe(true);
    });
  });
});
