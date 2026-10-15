import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, companyAgentDefaults, createDb, heartbeatRuns, routines } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { structuralFindingService } from "../services/structural-findings.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres structural-findings tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const TEN_DAYS = 10 * 24 * 60 * 60 * 1000;
const FORTY_DAYS = 40 * 24 * 60 * 60 * 1000;

describeEmbeddedPostgres("structural finding service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-structural-findings-");
    db = createDb(tempDb.connectionString);
  }, 90_000);

  afterEach(async () => {
    await db.delete(routines);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companyAgentDefaults);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function createAgent(companyId: string, overrides: Partial<typeof agents.$inferInsert> = {}) {
    const agentId = overrides.id ?? randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: overrides.name ?? "Worker",
      role: overrides.role ?? "engineer",
      status: overrides.status ?? "idle",
      adapterType: overrides.adapterType ?? "process",
      adapterConfig: overrides.adapterConfig ?? {},
      runtimeConfig: overrides.runtimeConfig ?? {},
      permissions: overrides.permissions ?? {},
      reportsTo: overrides.reportsTo ?? null,
      createdAt: overrides.createdAt ?? new Date(Date.now() - TEN_DAYS),
      lastHeartbeatAt: overrides.lastHeartbeatAt ?? null,
    });
    return agentId;
  }

  it("flags an agent with no manager and a non-CEO role, after the new-agent grace period", async () => {
    const companyId = await createCompany();
    const ceoId = await createAgent(companyId, { role: "ceo", name: "Ada" });
    const orphanId = await createAgent(companyId, {
      role: "engineer",
      name: "Bob",
      reportsTo: null,
    });
    const managedId = await createAgent(companyId, {
      role: "engineer",
      name: "Carol",
      reportsTo: ceoId,
    });
    const fresh = await createAgent(companyId, {
      role: "engineer",
      name: "Dan",
      createdAt: new Date(),
    });

    const findings = await structuralFindingService(db).detectOrphanNoManager(companyId);

    const subjectIds = findings.map((f) => f.subjectId).sort();
    expect(subjectIds).toEqual([orphanId].sort());
    expect(findings).not.toContain(expect.objectContaining({ subjectId: ceoId }));
    expect(findings).not.toContain(expect.objectContaining({ subjectId: managedId }));
    expect(findings).not.toContain(expect.objectContaining({ subjectId: fresh }));
    expect(findings[0].fingerprint).toBeTruthy();
  });

  it("flags an agent with no recent heartbeats and no recent runs as idle", async () => {
    const companyId = await createCompany();
    const idleId = await createAgent(companyId, {
      name: "Sleepy",
      createdAt: new Date(Date.now() - FORTY_DAYS),
      lastHeartbeatAt: new Date(Date.now() - FORTY_DAYS),
    });
    const activeId = await createAgent(companyId, {
      name: "Busy",
      createdAt: new Date(Date.now() - FORTY_DAYS),
      lastHeartbeatAt: new Date(),
    });
    const newId = await createAgent(companyId, {
      name: "Newbie",
      createdAt: new Date(),
    });

    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: activeId,
      invocationSource: "assignment",
      status: "completed",
      startedAt: new Date(),
    });

    const findings = await structuralFindingService(db).detectIdleAgents(companyId);
    const subjectIds = findings.map((f) => f.subjectId);
    expect(subjectIds).toContain(idleId);
    expect(subjectIds).not.toContain(activeId);
    expect(subjectIds).not.toContain(newId);
  });

  it("does not flag idle when there's a recent run even though lastHeartbeatAt is stale", async () => {
    const companyId = await createCompany();
    const id = await createAgent(companyId, {
      name: "RunOnly",
      createdAt: new Date(Date.now() - FORTY_DAYS),
      lastHeartbeatAt: new Date(Date.now() - FORTY_DAYS),
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: id,
      invocationSource: "assignment",
      status: "completed",
      startedAt: new Date(Date.now() - 1000),
    });

    const findings = await structuralFindingService(db).detectIdleAgents(companyId);
    expect(findings.map((f) => f.subjectId)).not.toContain(id);
  });

  it("flags companies with active agents but no active routines", async () => {
    const companyId = await createCompany();
    await createAgent(companyId, { name: "Worker" });

    const findings = await structuralFindingService(db).detectCompanyNoRoutines(companyId);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "company_no_routines",
      subjectType: "company",
      subjectId: companyId,
    });
  });

  it("does not flag companies that have at least one active routine", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, { name: "Worker" });
    await db.insert(routines).values({
      id: randomUUID(),
      companyId,
      title: "Daily sweep",
      assigneeAgentId: agentId,
      status: "active",
    });

    const findings = await structuralFindingService(db).detectCompanyNoRoutines(companyId);
    expect(findings).toHaveLength(0);
  });

  it("flags agent go-ahead exceptions that are broader than company policy", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, {
      name: "Builder",
      role: "engineer",
      permissions: { actionApprovalModes: { post_publicly: "go_ahead" } },
    });

    const findings = await structuralFindingService(db).detectBroadAgentActionPermissions(companyId);

    expect(findings).toEqual([
      expect.objectContaining({
        kind: "broad_agent_action_permission",
        subjectId: agentId,
        details: expect.objectContaining({
          actionType: "post_publicly",
          companyMode: "ask_first",
          agentMode: "go_ahead",
        }),
      }),
    ]);
  });

  it("does not flag an agent exception that is no broader than company policy", async () => {
    const companyId = await createCompany();
    await createAgent(companyId, {
      permissions: { actionApprovalModes: { post_publicly: "ask_first" } },
    });

    const findings = await structuralFindingService(db).detectBroadAgentActionPermissions(companyId);
    expect(findings).toHaveLength(0);
  });

  it("does not flag go-ahead access that matches the agent's stated job", async () => {
    const companyId = await createCompany();
    await createAgent(companyId, {
      role: "finance",
      title: "Billing specialist",
      permissions: { actionApprovalModes: { move_money: "go_ahead" } },
    });

    const findings = await structuralFindingService(db).detectBroadAgentActionPermissions(companyId);
    expect(findings).toHaveLength(0);
  });

  it("does not confuse accounting with account when reviewing messaging access", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, {
      role: "accounting",
      permissions: { actionApprovalModes: { send_message: "go_ahead" } },
    });

    const findings = await structuralFindingService(db).detectBroadAgentActionPermissions(companyId);

    expect(findings).toEqual([
      expect.objectContaining({
        subjectId: agentId,
        details: expect.objectContaining({ actionType: "send_message" }),
      }),
    ]);
  });

  it("does not confuse underwriter with writer when reviewing file access", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, {
      role: "underwriter",
      permissions: { actionApprovalModes: { change_files: "go_ahead" } },
    });

    const findings = await structuralFindingService(db).detectBroadAgentActionPermissions(companyId);

    expect(findings).toEqual([
      expect.objectContaining({
        subjectId: agentId,
        details: expect.objectContaining({ actionType: "change_files" }),
      }),
    ]);
  });

  it("flags company-wide go-ahead permissions for each active agent", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, { role: "engineer" });
    await db.insert(companyAgentDefaults).values({
      companyId,
      agentDefaults: { actionApprovalModes: { move_money: "go_ahead" } },
    });

    const findings = await structuralFindingService(db).detectBroadAgentActionPermissions(companyId);

    expect(findings).toEqual([
      expect.objectContaining({
        subjectId: agentId,
        details: expect.objectContaining({
          actionType: "move_money",
          companyMode: "go_ahead",
          agentMode: "go_ahead",
          policySource: "company",
          role: "engineer",
        }),
      }),
    ]);
  });

  it("does not review permissions for terminated agents", async () => {
    const companyId = await createCompany();
    await createAgent(companyId, {
      status: "terminated",
      permissions: { actionApprovalModes: { move_money: "go_ahead" } },
    });

    const findings = await structuralFindingService(db).detectBroadAgentActionPermissions(companyId);

    expect(findings).toHaveLength(0);
  });

  it("scan() runs every detector by default and respects an opt-in kinds list", async () => {
    const companyId = await createCompany();
    await createAgent(companyId, { name: "Solo", reportsTo: null, role: "engineer" });

    const all = await structuralFindingService(db).scan(companyId);
    const kinds = new Set(all.map((f) => f.kind));
    expect(kinds.has("orphan_no_manager")).toBe(true);
    expect(kinds.has("company_no_routines")).toBe(true);
    expect(kinds.has("broad_agent_action_permission")).toBe(false);

    const onlyOne = await structuralFindingService(db).scan(companyId, ["orphan_no_manager"]);
    expect(onlyOne.every((f) => f.kind === "orphan_no_manager")).toBe(true);
  });

  it("emits stable fingerprints for the same finding across runs", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, {
      name: "Solo",
      reportsTo: null,
      role: "engineer",
    });

    const a = await structuralFindingService(db).detectOrphanNoManager(companyId);
    const b = await structuralFindingService(db).detectOrphanNoManager(companyId);
    expect(a.find((f) => f.subjectId === agentId)?.fingerprint).toEqual(
      b.find((f) => f.subjectId === agentId)?.fingerprint,
    );
  });
});
