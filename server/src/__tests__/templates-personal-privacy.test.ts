import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentTemplates,
  agents,
  companies,
  companyMemberships,
  companySkills,
  createDb,
  principalPermissionGrants,
  routineTemplates,
  routines,
  skillTemplates,
  templateDeployments,
} from "@paperclipai/db";
import type { HumanCompanyMembershipRole } from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { templateRoutes } from "../routes/templates.js";
import { grantsForHumanRole } from "../services/company-member-roles.js";
import { loadPersonalCompanyIndex } from "../services/personal-companies.js";
import { templateService } from "../services/templates.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// The library routes read a GitHub release; here they hand back a template
// whose deployments the test chooses.
const mockLibrary = vi.hoisted(() => ({
  installSingle: vi.fn(),
  updateFromLibrary: vi.fn(),
}));

vi.mock("../services/templates-library.js", () => ({
  templatesLibraryService: () => mockLibrary,
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres template privacy tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// The owner of this instance is an instance admin, the HQ owner, and the owner
// of his own Personal. Bob owns another Personal. Carol is an instance admin
// with no seat anywhere. Dana is an HQ admin who is not an instance admin. Her
// seats: admin in Delta; operator in Beta, which carries only tasks:assign;
// admin in Gamma, which requires board approval for new agents; operator in
// Foxtrot with tasks:assign taken away; viewer in Echo; none in Acme.
const OWNER = "user-owner";
const BOB = "user-bob";
const CAROL = "user-carol";
const DANA = "user-dana";
const PERSONAL_REFUSAL = "This is someone's personal company";
const APPROVAL_REFUSAL = "This company needs board approval for new agents";

const KINDS = ["agent", "routine", "skill"] as const;
type Kind = (typeof KINDS)[number];

/**
 * Templates are managed by instance admins and HQ owners and admins, and a
 * deploy writes into every company it names. Someone's Personal company is
 * theirs alone, so nobody else deploys into it or sees what went in there. An
 * HQ admin who is not an instance admin may read every company but write only
 * where they have a seat that allows it.
 */
describeEmbeddedPostgres("templates and Personal companies", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let hqId!: string;
  let acmeId!: string;
  let betaId!: string;
  let gammaId!: string;
  let deltaId!: string;
  let echoId!: string;
  let foxtrotId!: string;
  let bobPersonalId!: string;
  let ownerPersonalId!: string;
  const templateIds = {} as Record<Kind, string>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-templates-personal-");
    db = createDb(tempDb.connectionString);
  }, 90_000);

  async function clearTables() {
    await db.delete(templateDeployments);
    await db.delete(agentTemplates);
    await db.delete(routineTemplates);
    await db.delete(skillTemplates);
    await db.delete(companySkills);
    await db.delete(routines);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    // The migrations seed an HQ company of their own, and there can only be one.
    await db.delete(companies);
  }

  /** Dana's seats, each with the permissions that role grants unless given others. */
  const danaSeats = (): Array<[string, HumanCompanyMembershipRole, Array<{ permissionKey: string }>?]> => [
    [hqId, "admin"],
    [betaId, "operator"],
    [gammaId, "admin"],
    [deltaId, "admin"],
    [echoId, "viewer"],
    [foxtrotId, "operator", []],
  ];

  beforeEach(async () => {
    await clearTables();
    hqId = randomUUID();
    acmeId = randomUUID();
    betaId = randomUUID();
    gammaId = randomUUID();
    deltaId = randomUUID();
    echoId = randomUUID();
    foxtrotId = randomUUID();
    bobPersonalId = randomUUID();
    ownerPersonalId = randomUUID();
    await db.insert(companies).values([
      { id: hqId, name: "HQ", issuePrefix: "HQT", isPortfolioRoot: true },
      { id: acmeId, name: "Acme", issuePrefix: "ACT" },
      { id: betaId, name: "Beta", issuePrefix: "BET" },
      { id: gammaId, name: "Gamma", issuePrefix: "GAT", requireBoardApprovalForNewAgents: true },
      { id: deltaId, name: "Delta", issuePrefix: "DET" },
      { id: echoId, name: "Echo", issuePrefix: "ECT" },
      { id: foxtrotId, name: "Foxtrot", issuePrefix: "FOT" },
      { id: bobPersonalId, name: "Personal", issuePrefix: "MET", kind: "personal", ownerUserId: BOB },
      { id: ownerPersonalId, name: "Personal", issuePrefix: "ME2T", kind: "personal", ownerUserId: OWNER },
    ]);
    // Written as an invite or a role change writes them, which is what the
    // company's own routes read.
    for (const [companyId, role, grants = grantsForHumanRole(role)] of danaSeats()) {
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: DANA,
        status: "active",
        membershipRole: role,
      });
      if (grants.length > 0) {
        await db.insert(principalPermissionGrants).values(
          grants.map((grant) => ({
            companyId,
            principalType: "user",
            principalId: DANA,
            permissionKey: grant.permissionKey,
          })),
        );
      }
    }
    await loadPersonalCompanyIndex(db);

    const templates = templateService(db);
    const agentTemplate = await templates.createAgentTemplate({
      name: "Night watch",
      agentName: "Night watch",
      role: "general",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      forbiddenWritePaths: [],
      budgetMonthlyCents: 0,
    }, { userId: OWNER });
    const routineTemplate = await templates.createRoutineTemplate({
      name: "Daily check",
      routineTitle: "Daily check",
      priority: "medium",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      variables: [],
      triggers: [],
    }, { userId: OWNER });
    const skillTemplate = await templates.createSkillTemplate({
      name: "Checklist",
      skillKey: "checklist",
      skillName: "Checklist",
      markdown: "---\nname: Checklist\n---\n\n# Checklist\n",
    }, { userId: OWNER });
    templateIds.agent = agentTemplate.id;
    templateIds.routine = routineTemplate.id;
    templateIds.skill = skillTemplate.id;

    mockLibrary.installSingle.mockReset();
    mockLibrary.updateFromLibrary.mockReset();
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
    isPortfolioRootUserAdmin: true,
    companyIds: [hqId, ownerPersonalId],
    memberships: [
      { companyId: hqId, membershipRole: "owner", status: "active" },
      { companyId: ownerPersonalId, membershipRole: "owner", status: "active" },
    ],
  });
  const carol = () => ({
    type: "board",
    userId: CAROL,
    source: "session",
    isInstanceAdmin: true,
    companyIds: [],
    memberships: [],
  });
  const dana = () => ({
    type: "board",
    userId: DANA,
    source: "session",
    isInstanceAdmin: false,
    isPortfolioRootUserAdmin: true,
    companyIds: danaSeats().map(([companyId]) => companyId),
    memberships: danaSeats().map(([companyId, membershipRole]) => ({ companyId, membershipRole, status: "active" })),
  });

  function app(actor: Record<string, unknown>) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      (req as unknown as { actor: Record<string, unknown> }).actor = actor;
      next();
    });
    instance.use("/api", templateRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  async function deploy(actor: Record<string, unknown>, kind: Kind, companyIds: string[]) {
    const res = await request(app(actor))
      .post(`/api/templates/${kind}/${templateIds[kind]}/deploy`)
      .send({ companyIds, skipExisting: false });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.results as Array<Record<string, unknown>>;
  }

  /** How many of what a template of this kind makes are in the company. */
  async function madeIn(kind: Kind, companyId: string) {
    const table = kind === "agent" ? agents : kind === "routine" ? routines : companySkills;
    const rows = await db.select({ id: table.id }).from(table).where(eq(table.companyId, companyId));
    return rows.length;
  }

  async function deploymentsIn(companyId: string) {
    const rows = await db
      .select({ id: templateDeployments.id })
      .from(templateDeployments)
      .where(eq(templateDeployments.companyId, companyId));
    return rows.length;
  }

  const refused = (companyId: string, companyName: string, message: string) => ({
    companyId,
    companyName,
    status: "error",
    deployedEntityId: null,
    message,
  });

  describe("deploying", () => {
    it.each(KINDS)("keeps an instance admin's %s template out of someone else's Personal company", async (kind) => {
      const results = await deploy(carol(), kind, [acmeId, bobPersonalId]);

      expect(results).toEqual([
        expect.objectContaining({ companyId: acmeId, companyName: "Acme", status: "created" }),
        // Named by its id alone, as an unknown company is.
        refused(bobPersonalId, bobPersonalId, PERSONAL_REFUSAL),
      ]);
      expect(await madeIn(kind, bobPersonalId)).toBe(0);
      expect(await deploymentsIn(bobPersonalId)).toBe(0);
    });

    // What Dana could make in each company herself, through its own create
    // routes: an agent or a skill needs agents:create, a routine tasks:assign,
    // and a new agent also a company that does not require board approval.
    it.each([
      ["agent", { beta: "Missing permission: agents:create", gamma: APPROVAL_REFUSAL, foxtrot: "Missing permission: agents:create" }],
      ["skill", { beta: "Missing permission: agents:create", gamma: null, foxtrot: "Missing permission: agents:create" }],
      ["routine", { beta: null, gamma: null, foxtrot: "Missing permission: tasks:assign" }],
    ] as const)(
      "lets an HQ admin who is not an instance admin deploy a %s template only where she could make one herself",
      async (kind, refusals) => {
        const results = await deploy(dana(), kind, [deltaId, betaId, gammaId, foxtrotId, echoId, acmeId, bobPersonalId]);
        const createdOrRefused = (companyId: string, companyName: string, refusal: string | null) =>
          refusal
            ? refused(companyId, companyName, refusal)
            : expect.objectContaining({ companyId, companyName, status: "created" });

        expect(results).toEqual([
          createdOrRefused(deltaId, "Delta", null),
          createdOrRefused(betaId, "Beta", refusals.beta),
          createdOrRefused(gammaId, "Gamma", refusals.gamma),
          createdOrRefused(foxtrotId, "Foxtrot", refusals.foxtrot),
          refused(echoId, "Echo", "Viewer access is read-only"),
          refused(acmeId, "Acme", "User does not have access to this company"),
          refused(bobPersonalId, bobPersonalId, PERSONAL_REFUSAL),
        ]);
        expect(await madeIn(kind, betaId)).toBe(refusals.beta ? 0 : 1);
        expect(await madeIn(kind, gammaId)).toBe(refusals.gamma ? 0 : 1);
        for (const companyId of [foxtrotId, echoId, acmeId, bobPersonalId]) {
          expect(await madeIn(kind, companyId)).toBe(0);
        }
      },
    );

    it.each(KINDS)("still lets the owner deploy a %s template into HQ, any company, and his own Personal", async (kind) => {
      const results = await deploy(owner(), kind, [hqId, acmeId, ownerPersonalId]);

      expect(results).toEqual([
        expect.objectContaining({ companyId: hqId, status: "created" }),
        expect.objectContaining({ companyId: acmeId, status: "created" }),
        expect.objectContaining({ companyId: ownerPersonalId, companyName: "Personal", status: "created" }),
      ]);
      expect(await madeIn(kind, ownerPersonalId)).toBe(1);
    });
  });

  describe("deployment lists", () => {
    async function seedDeployments() {
      await db.insert(templateDeployments).values(
        [acmeId, bobPersonalId, ownerPersonalId].map((companyId) => ({
          templateType: "agent",
          templateId: templateIds.agent,
          companyId,
          deployedEntityId: randomUUID(),
        })),
      );
    }

    const deployedTo = (deployments: Array<{ companyId: string }>) =>
      deployments.map((deployment) => deployment.companyId).sort();

    async function everyListSeenBy(actor: Record<string, unknown>) {
      const detail = await request(app(actor)).get(`/api/templates/agent/${templateIds.agent}`);
      const list = await request(app(actor)).get(`/api/templates/agent/${templateIds.agent}/deployments`);
      const saved = await request(app(actor))
        .patch(`/api/templates/agent/${templateIds.agent}`)
        .send({ description: "Watches overnight runs" });
      for (const res of [detail, list, saved]) expect(res.status, JSON.stringify(res.body)).toBe(200);
      return {
        detail: deployedTo(detail.body.deployments),
        list: deployedTo(list.body.deployments),
        saved: deployedTo(saved.body.deployments),
      };
    }

    it.each([
      ["an instance admin", carol],
      ["an HQ admin who is not an instance admin", dana],
    ])("leave someone else's Personal company out for %s", async (_who, actor) => {
      await seedDeployments();
      const onlyAcme = [acmeId];

      expect(await everyListSeenBy(actor())).toEqual({ detail: onlyAcme, list: onlyAcme, saved: onlyAcme });
    });

    it("still show the owner his own Personal company", async () => {
      await seedDeployments();
      const acmeAndHisOwn = [acmeId, ownerPersonalId].sort();

      expect(await everyListSeenBy(owner())).toEqual({
        detail: acmeAndHisOwn,
        list: acmeAndHisOwn,
        saved: acmeAndHisOwn,
      });
    });

    it("leave someone else's Personal company out of what the library routes send back", async () => {
      const template = {
        id: templateIds.agent,
        name: "Night watch",
        deployments: [acmeId, bobPersonalId].map((companyId) => ({
          id: randomUUID(),
          templateType: "agent",
          templateId: templateIds.agent,
          companyId,
          deployedEntityId: randomUUID(),
        })),
      };
      mockLibrary.installSingle.mockResolvedValue({ status: "skipped", template });
      mockLibrary.updateFromLibrary.mockResolvedValue(template);

      const installed = await request(app(carol()))
        .post("/api/templates/library/install")
        .send({ kind: "agent", name: "night-watch" });
      const updated = await request(app(carol()))
        .post("/api/templates/library/update")
        .send({ kind: "agent", name: "night-watch" });

      expect(installed.status, JSON.stringify(installed.body)).toBe(200);
      expect(updated.status, JSON.stringify(updated.body)).toBe(200);
      expect(deployedTo(installed.body.template.deployments)).toEqual([acmeId]);
      expect(deployedTo(updated.body.template.deployments)).toEqual([acmeId]);
    });
  });
});
