import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
  agents,
  companies,
  companyMemberships,
  companySkills,
  createDb,
  environments,
  principalPermissionGrants,
} from "@paperclipai/db";
import type { PermissionKey } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentRoutes } from "../routes/agents.js";
import { companySkillRoutes } from "../routes/company-skills.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Company Access grant tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// The refusals each route gave before these grants were enforced.
const MEMBER_REFUSAL = { error: "Missing permission: agents:create" };
const AGENT_UPDATE_REFUSAL = { error: "Only CEO or agent creators can modify other agents" };
const AGENT_CREATE_REFUSAL = { error: "Missing permission: can create agents" };
// What PATCH tells an agent caller, and a config rollback now tells it too.
const ROLE_REFUSAL = { error: "Only CEO or board members can change agent roles." };
const INSTRUCTIONS_REFUSAL = {
  error: "Agent-authenticated callers cannot modify instructions path or bundle configuration (instructionsFilePath)",
};

describeEmbeddedPostgres("Company Access agent and skill grants", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const cleanupDirs = new Set<string>();
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;
  const originalPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-access-grants-");
    db = createDb(tempDb.connectionString);
  }, 90_000);

  // New skills are written under the instance folder, so each test gets its own.
  beforeEach(async () => {
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-access-grants-home-"));
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
  });

  afterEach(async () => {
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
    if (originalPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalPaperclipInstanceId;

    await db.delete(activityLog);
    await db.delete(agentConfigRevisions);
    await db.delete(companySkills);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(companies);
    await Promise.all(Array.from(cleanupDirs, (dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(actor: Record<string, unknown>) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    instance.use("/api", agentRoutes(db));
    instance.use("/api", companySkillRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Access Co",
      issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, values: Partial<typeof agents.$inferInsert> = {}) {
    const [agent] = await db.insert(agents).values({
      companyId,
      name: "Writer",
      adapterConfig: { model: "writer-model" },
      ...values,
    }).returning();
    return agent!;
  }

  async function seedGrants(
    companyId: string,
    principalType: "user" | "agent",
    principalId: string,
    keys: PermissionKey[],
  ) {
    await db.insert(companyMemberships).values({
      companyId,
      principalType,
      principalId,
      status: "active",
      membershipRole: principalType === "user" ? "operator" : "member",
    });
    if (keys.length === 0) return;
    await db.insert(principalPermissionGrants).values(
      keys.map((permissionKey) => ({ companyId, principalType, principalId, permissionKey })),
    );
  }

  // A signed-in member who is not an instance admin, holding only these grants.
  async function member(companyId: string, keys: PermissionKey[]) {
    const userId = `member-${randomUUID()}`;
    await seedGrants(companyId, "user", userId, keys);
    return {
      type: "board",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "operator", status: "active" }],
      source: "session",
      isInstanceAdmin: false,
    };
  }

  // An agent's own permissions live on the agent: grants, or its flags.
  async function agentActor(
    companyId: string,
    keys: PermissionKey[],
    values: Partial<typeof agents.$inferInsert> = {},
  ) {
    const agent = await seedAgent(companyId, { name: "Manager", ...values });
    await seedGrants(companyId, "agent", agent.id, keys);
    return { type: "agent", agentId: agent.id, companyId, source: "agent_key" };
  }

  async function savedAgent(agentId: string) {
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    return row!;
  }

  // A saved revision of the agent's configuration, with these changes in it.
  async function seedRevision(target: typeof agents.$inferSelect, changes: Record<string, unknown>) {
    const snapshot = {
      name: target.name,
      role: target.role,
      title: target.title,
      reportsTo: target.reportsTo,
      capabilities: target.capabilities,
      adapterType: target.adapterType,
      adapterConfig: target.adapterConfig,
      runtimeConfig: target.runtimeConfig,
      defaultEnvironmentId: target.defaultEnvironmentId,
      budgetMonthlyCents: target.budgetMonthlyCents,
      metadata: target.metadata,
    };
    const [revision] = await db.insert(agentConfigRevisions).values({
      companyId: target.companyId,
      agentId: target.id,
      changedKeys: Object.keys(changes),
      beforeConfig: snapshot,
      afterConfig: { ...snapshot, ...changes },
    }).returning();
    return revision!;
  }

  async function seedEnvironment(companyId: string) {
    const [environment] = await db.insert(environments).values({ companyId, name: "Sandbox" }).returning();
    return environment!.id;
  }

  function rollback(http: ReturnType<typeof request>, agentId: string, revisionId: string) {
    return http.post(`/api/agents/${agentId}/config-revisions/${revisionId}/rollback`).send({});
  }

  function clearInstructionsPath(agentId: string) {
    return { path: `/api/agents/${agentId}/instructions-path`, body: { path: null, adapterConfigKey: "instructionsFilePath" } };
  }

  describe("Configure agents and Suggest agent changes", () => {
    it("lets a member with only Configure agents change an agent and read its configuration", async () => {
      const companyId = await seedCompany();
      const target = await seedAgent(companyId);
      const http = request(app(await member(companyId, ["agents:configure"])));

      const patched = await http.patch(`/api/agents/${target.id}`).send({ title: "Lead writer" });
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
      expect((await savedAgent(target.id)).title).toBe("Lead writer");

      const configuration = await http.get(`/api/agents/${target.id}/configuration`);
      expect(configuration.status, JSON.stringify(configuration.body)).toBe(200);
      expect(configuration.body.adapterConfig).toMatchObject({ model: "writer-model" });

      const detail = await http.get(`/api/agents/${target.id}`);
      expect(detail.status, JSON.stringify(detail.body)).toBe(200);
      expect(detail.body.adapterConfig).toMatchObject({ model: "writer-model" });
    });

    it("lets a member with only Configure agents change an agent's instructions path", async () => {
      const companyId = await seedCompany();
      const target = await seedAgent(companyId, {
        adapterConfig: { model: "writer-model", instructionsFilePath: "docs/AGENTS.md" },
      });
      const http = request(app(await member(companyId, ["agents:configure"])));
      const clear = clearInstructionsPath(target.id);

      const res = await http.patch(clear.path).send(clear.body);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((await savedAgent(target.id)).adapterConfig).not.toHaveProperty("instructionsFilePath");
    });

    it("gives a member with only Suggest agent changes nothing yet", async () => {
      const companyId = await seedCompany();
      const target = await seedAgent(companyId);
      const http = request(app(await member(companyId, ["agents:suggest-changes"])));

      const configuration = await http.get(`/api/agents/${target.id}/configuration`);
      expect(configuration.status, JSON.stringify(configuration.body)).toBe(403);
      expect(configuration.body).toEqual(MEMBER_REFUSAL);

      const instructions = await http.get(`/api/agents/${target.id}/instructions-bundle/file`).query({ path: "AGENTS.md" });
      expect(instructions.status, JSON.stringify(instructions.body)).toBe(403);
      expect(instructions.body).toEqual(MEMBER_REFUSAL);

      // The agent stays visible, without its configuration.
      const detail = await http.get(`/api/agents/${target.id}`);
      expect(detail.status, JSON.stringify(detail.body)).toBe(200);
      expect(detail.body.adapterConfig).toEqual({});
      const list = await http.get(`/api/companies/${companyId}/agents`);
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      expect(list.body.find((row: { id: string }) => row.id === target.id).adapterConfig).toEqual({});

      const patched = await http.patch(`/api/agents/${target.id}`).send({ title: "Lead writer" });
      expect(patched.status, JSON.stringify(patched.body)).toBe(403);
      expect(patched.body).toEqual(MEMBER_REFUSAL);
      expect((await savedAgent(target.id)).title).toBeNull();
    });

    it("gives an agent with only Suggest agent changes nothing yet", async () => {
      const companyId = await seedCompany();
      const target = await seedAgent(companyId);
      const http = request(app(await agentActor(companyId, ["agents:suggest-changes"])));

      const configuration = await http.get(`/api/agents/${target.id}/configuration`);
      expect(configuration.status, JSON.stringify(configuration.body)).toBe(403);
      expect(configuration.body).toEqual(AGENT_CREATE_REFUSAL);

      const detail = await http.get(`/api/agents/${target.id}`);
      expect(detail.status, JSON.stringify(detail.body)).toBe(200);
      expect(detail.body.adapterConfig).toEqual({});
      const list = await http.get(`/api/companies/${companyId}/agents`);
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      expect(list.body.find((row: { id: string }) => row.id === target.id).adapterConfig).toEqual({});

      const patched = await http.patch(`/api/agents/${target.id}`).send({ title: "Lead writer" });
      expect(patched.status, JSON.stringify(patched.body)).toBe(403);
      expect(patched.body).toEqual(AGENT_UPDATE_REFUSAL);
    });

    it("lets an agent with only Configure agents change another agent and read its configuration, and refuses one without it", async () => {
      const companyId = await seedCompany();
      const target = await seedAgent(companyId);
      const configurer = request(app(await agentActor(companyId, ["agents:configure"])));
      const other = request(app(await agentActor(companyId, [])));

      const allowed = await configurer.patch(`/api/agents/${target.id}`).send({ title: "Lead writer" });
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
      expect((await savedAgent(target.id)).title).toBe("Lead writer");
      const configuration = await configurer.get(`/api/agents/${target.id}/configuration`);
      expect(configuration.status, JSON.stringify(configuration.body)).toBe(200);
      expect(configuration.body.adapterConfig).toMatchObject({ model: "writer-model" });

      const refused = await other.patch(`/api/agents/${target.id}`).send({ title: "Someone else" });
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(refused.body).toEqual(AGENT_UPDATE_REFUSAL);
      const hidden = await other.get(`/api/agents/${target.id}/configuration`);
      expect(hidden.status, JSON.stringify(hidden.body)).toBe(403);
      expect(hidden.body).toEqual(AGENT_CREATE_REFUSAL);
    });

    it("refuses a member with neither grant the way it did before", async () => {
      const companyId = await seedCompany();
      const target = await seedAgent(companyId, {
        adapterConfig: { model: "writer-model", instructionsFilePath: "docs/AGENTS.md" },
      });
      const http = request(app(await member(companyId, [])));
      const clear = clearInstructionsPath(target.id);

      const patched = await http.patch(`/api/agents/${target.id}`).send({ title: "Lead writer" });
      expect(patched.status, JSON.stringify(patched.body)).toBe(403);
      expect(patched.body).toEqual(MEMBER_REFUSAL);

      const instructions = await http.patch(clear.path).send(clear.body);
      expect(instructions.status, JSON.stringify(instructions.body)).toBe(403);
      expect(instructions.body).toEqual(MEMBER_REFUSAL);

      const configuration = await http.get(`/api/agents/${target.id}/configuration`);
      expect(configuration.status, JSON.stringify(configuration.body)).toBe(403);
      expect(configuration.body).toEqual(MEMBER_REFUSAL);

      // The agent itself stays visible, without its configuration.
      const detail = await http.get(`/api/agents/${target.id}`);
      expect(detail.status, JSON.stringify(detail.body)).toBe(200);
      expect(detail.body.adapterConfig).toEqual({});

      expect(await savedAgent(target.id)).toMatchObject({
        title: null,
        adapterConfig: { model: "writer-model", instructionsFilePath: "docs/AGENTS.md" },
      });
    });

    it("keeps a member who holds agents:create changing agents and reading configurations", async () => {
      const companyId = await seedCompany();
      const target = await seedAgent(companyId, {
        adapterConfig: { model: "writer-model", instructionsFilePath: "docs/AGENTS.md" },
      });
      const http = request(app(await member(companyId, ["agents:create"])));
      const clear = clearInstructionsPath(target.id);

      const patched = await http.patch(`/api/agents/${target.id}`).send({ title: "Lead writer" });
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);

      const instructions = await http.patch(clear.path).send(clear.body);
      expect(instructions.status, JSON.stringify(instructions.body)).toBe(200);

      const configuration = await http.get(`/api/agents/${target.id}/configuration`);
      expect(configuration.status, JSON.stringify(configuration.body)).toBe(200);
      expect(configuration.body.adapterConfig).toMatchObject({ model: "writer-model" });
    });

    it.each([
      ["by grant", ["agents:create"] as PermissionKey[], {}],
      ["by its canCreateAgents flag", [] as PermissionKey[], { permissions: { canCreateAgents: true } }],
    ])("keeps an agent that can create agents %s changing other agents and reading their configuration", async (_label, keys, values) => {
      const companyId = await seedCompany();
      const target = await seedAgent(companyId);
      const http = request(app(await agentActor(companyId, keys, values)));

      const patched = await http.patch(`/api/agents/${target.id}`).send({ title: "Lead writer" });
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
      expect((await savedAgent(target.id)).title).toBe("Lead writer");

      const configuration = await http.get(`/api/agents/${target.id}/configuration`);
      expect(configuration.status, JSON.stringify(configuration.body)).toBe(200);
      expect(configuration.body.adapterConfig).toMatchObject({ model: "writer-model" });
    });

    it("keeps the local board and instance admins at full access", async () => {
      const companyId = await seedCompany();
      const target = await seedAgent(companyId);
      const localBoard = { type: "board", userId: "local-board", companyIds: [companyId], source: "local_implicit", isInstanceAdmin: false };
      const instanceAdmin = { type: "board", userId: "admin-user", companyIds: [companyId], source: "session", isInstanceAdmin: true };

      for (const actor of [localBoard, instanceAdmin]) {
        const http = request(app(actor));
        const patched = await http.patch(`/api/agents/${target.id}`).send({ title: `Set by ${actor.userId}` });
        expect(patched.status, JSON.stringify(patched.body)).toBe(200);
        const configuration = await http.get(`/api/agents/${target.id}/configuration`);
        expect(configuration.status, JSON.stringify(configuration.body)).toBe(200);
      }
    });
  });

  // The targets use a non-process adapter: for the process adapter every
  // setting counts as a host command, which already refuses an agent rollback.
  describe("Config rollback by an agent caller", () => {
    it.each([
      ["Configure agents", ["agents:configure"] as PermissionKey[]],
      ["agents:create", ["agents:create"] as PermissionKey[]],
    ])("refuses an agent holding %s a role change by rollback, as PATCH does", async (_label, keys) => {
      const companyId = await seedCompany();
      const target = await seedAgent(companyId, { adapterType: "claude_local" });
      const revision = await seedRevision(target, { role: "cto" });
      const http = request(app(await agentActor(companyId, keys)));

      const patched = await http.patch(`/api/agents/${target.id}`).send({ role: "cto" });
      expect(patched.status, JSON.stringify(patched.body)).toBe(403);
      expect(patched.body).toEqual(ROLE_REFUSAL);

      const rolledBack = await rollback(http, target.id, revision.id);
      expect(rolledBack.status, JSON.stringify(rolledBack.body)).toBe(403);
      expect(rolledBack.body).toEqual(ROLE_REFUSAL);
      expect((await savedAgent(target.id)).role).toBe("general");
    });

    it("lets the CEO agent roll another agent back to a different role", async () => {
      const companyId = await seedCompany();
      const target = await seedAgent(companyId, { adapterType: "claude_local" });
      const revision = await seedRevision(target, { role: "cto" });

      const res = await rollback(request(app(await agentActor(companyId, [], { role: "ceo" }))), target.id, revision.id);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((await savedAgent(target.id)).role).toBe("cto");
    });

    it("refuses an agent an instructions change by rollback, as PATCH does, and allows one that keeps them", async () => {
      const companyId = await seedCompany();
      const target = await seedAgent(companyId, {
        adapterType: "claude_local",
        adapterConfig: { model: "writer-model", instructionsFilePath: "docs/AGENTS.md" },
      });
      const moved = await seedRevision(target, {
        adapterConfig: { model: "writer-model", instructionsFilePath: "docs/OTHER.md" },
      });
      const removed = await seedRevision(target, { adapterConfig: { model: "writer-model" } });
      const retitled = await seedRevision(target, { title: "Lead writer" });
      const http = request(app(await agentActor(companyId, ["agents:configure"])));

      const patched = await http.patch(`/api/agents/${target.id}`).send({
        adapterConfig: { instructionsFilePath: "docs/OTHER.md" },
      });
      expect(patched.status, JSON.stringify(patched.body)).toBe(403);
      expect(patched.body).toEqual(INSTRUCTIONS_REFUSAL);

      for (const revision of [moved, removed]) {
        const res = await rollback(http, target.id, revision.id);
        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(res.body).toEqual(INSTRUCTIONS_REFUSAL);
      }
      expect((await savedAgent(target.id)).adapterConfig).toEqual({
        model: "writer-model",
        instructionsFilePath: "docs/AGENTS.md",
      });

      const kept = await rollback(http, target.id, retitled.id);
      expect(kept.status, JSON.stringify(kept.body)).toBe(200);
      expect(await savedAgent(target.id)).toMatchObject({
        title: "Lead writer",
        adapterConfig: { model: "writer-model", instructionsFilePath: "docs/AGENTS.md" },
      });
    });

    const selfChanges: Array<[string, (companyId: string) => Promise<Record<string, unknown>>, string]> = [
      ["budgetMonthlyCents", async () => ({ budgetMonthlyCents: 1000 }), "'budgetMonthlyCents'"],
      ["adapterType", async () => ({ adapterType: "codex_local" }), "'adapterType'"],
      [
        "defaultEnvironmentId",
        async (companyId) => ({ defaultEnvironmentId: await seedEnvironment(companyId) }),
        "'defaultEnvironmentId'",
      ],
      ["role", async () => ({ role: "cto" }), "'role'"],
      [
        "adapterConfig.dangerouslySkipPermissions",
        async () => ({ adapterConfig: { model: "writer-model", dangerouslySkipPermissions: true } }),
        "adapterConfig.dangerouslySkipPermissions",
      ],
    ];

    it.each(selfChanges)("refuses an agent rolling itself back to a different %s, as PATCH does", async (_label, changesFor, what) => {
      const companyId = await seedCompany();
      const actor = await agentActor(companyId, [], { adapterType: "claude_local", budgetMonthlyCents: 5000 });
      const self = await savedAgent(actor.agentId);
      const changes = await changesFor(companyId);
      const revision = await seedRevision(self, changes);
      const http = request(app(actor));
      const refusal = { error: `Agents cannot self-modify ${what}; ask a CEO or board member.` };

      const patched = await http.patch(`/api/agents/${self.id}`).send(changes);
      expect(patched.status, JSON.stringify(patched.body)).toBe(403);
      expect(patched.body).toEqual(refusal);

      const rolledBack = await rollback(http, self.id, revision.id);
      expect(rolledBack.status, JSON.stringify(rolledBack.body)).toBe(403);
      expect(rolledBack.body).toEqual(refusal);
      expect(await savedAgent(self.id)).toEqual(self);
    });

    it("lets an agent roll itself back when only allowed fields change, and roll another agent's budget and adapter type back", async () => {
      const companyId = await seedCompany();
      const actor = await agentActor(companyId, ["agents:configure"], { adapterType: "claude_local" });
      const self = await savedAgent(actor.agentId);
      const http = request(app(actor));

      const retitled = await seedRevision(self, { title: "Release manager" });
      const own = await rollback(http, self.id, retitled.id);
      expect(own.status, JSON.stringify(own.body)).toBe(200);
      expect((await savedAgent(self.id)).title).toBe("Release manager");

      const target = await seedAgent(companyId, { adapterType: "claude_local", budgetMonthlyCents: 5000 });
      const revision = await seedRevision(target, { budgetMonthlyCents: 1000, adapterType: "codex_local" });
      const other = await rollback(http, target.id, revision.id);
      expect(other.status, JSON.stringify(other.body)).toBe(200);
      expect(await savedAgent(target.id)).toMatchObject({ budgetMonthlyCents: 1000, adapterType: "codex_local" });
    });

    it("leaves rollbacks by people unchanged", async () => {
      const companyId = await seedCompany();
      const target = await seedAgent(companyId, {
        adapterType: "claude_local",
        adapterConfig: { model: "writer-model", instructionsFilePath: "docs/AGENTS.md" },
      });
      const roleRevision = await seedRevision(target, { role: "cto" });
      const instructionsRevision = await seedRevision(target, {
        adapterConfig: { model: "writer-model", instructionsFilePath: "docs/OTHER.md" },
      });
      const creator = request(app(await member(companyId, ["agents:create"])));
      const localBoard = request(app({
        type: "board",
        userId: "local-board",
        companyIds: [companyId],
        source: "local_implicit",
        isInstanceAdmin: false,
      }));

      const role = await rollback(creator, target.id, roleRevision.id);
      expect(role.status, JSON.stringify(role.body)).toBe(200);
      expect((await savedAgent(target.id)).role).toBe("cto");

      const instructions = await rollback(localBoard, target.id, instructionsRevision.id);
      expect(instructions.status, JSON.stringify(instructions.body)).toBe(200);
      expect((await savedAgent(target.id)).adapterConfig).toEqual({
        model: "writer-model",
        instructionsFilePath: "docs/OTHER.md",
      });
    });
  });

  describe("Create skills and Suggest skill changes", () => {
    it("lets a member with only Create skills add and delete a company skill", async () => {
      const companyId = await seedCompany();
      const http = request(app(await member(companyId, ["skills:create"])));

      const created = await http.post(`/api/companies/${companyId}/skills`).send({ name: "Release notes" });
      expect(created.status, JSON.stringify(created.body)).toBe(201);

      const deleted = await http.delete(`/api/companies/${companyId}/skills/${created.body.id}`);
      expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
      expect(await db.select().from(companySkills).where(eq(companySkills.companyId, companyId))).toEqual([]);
    });

    it("lets an agent with only Create skills add a company skill, and refuses one without it", async () => {
      const companyId = await seedCompany();

      const allowed = await request(app(await agentActor(companyId, ["skills:create"])))
        .post(`/api/companies/${companyId}/skills`)
        .send({ name: "Release notes" });
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);

      const refused = await request(app(await agentActor(companyId, [])))
        .post(`/api/companies/${companyId}/skills`)
        .send({ name: "Changelog" });
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(refused.body).toEqual(AGENT_CREATE_REFUSAL);
    });

    it.each([
      ["only Suggest skill changes", ["skills:suggest-changes"] as PermissionKey[]],
      ["no grant", [] as PermissionKey[]],
    ])("refuses a member with %s the way it did before", async (_label, keys) => {
      const companyId = await seedCompany();
      const http = request(app(await member(companyId, keys)));

      const res = await http.post(`/api/companies/${companyId}/skills`).send({ name: "Release notes" });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body).toEqual(MEMBER_REFUSAL);
      expect(await db.select().from(companySkills).where(eq(companySkills.companyId, companyId))).toEqual([]);
    });

    it("keeps agents:create holders adding skills: a member, an agent by grant and an agent by its flag", async () => {
      const companyId = await seedCompany();
      const actors = [
        await member(companyId, ["agents:create"]),
        await agentActor(companyId, ["agents:create"]),
        await agentActor(companyId, [], { permissions: { canCreateAgents: true } }),
      ];

      for (const [index, actor] of actors.entries()) {
        const res = await request(app(actor))
          .post(`/api/companies/${companyId}/skills`)
          .send({ name: `Release notes ${index + 1}` });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
      }
    });
  });
});
