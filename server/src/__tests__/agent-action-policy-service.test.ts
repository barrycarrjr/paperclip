import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, companyAgentDefaults, createDb, instanceSettings } from "@paperclipai/db";
import { AGENT_ACTION_TYPES } from "@paperclipai/shared";
import { agentActionPolicyService } from "../services/agent-action-policy.ts";
import { agentService } from "../services/agents.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.ts";

async function closeDbClient(db: ReturnType<typeof createDb> | undefined) {
  await db?.$client?.end?.({ timeout: 0 });
}

describe("agentActionPolicyService", () => {
  let db!: ReturnType<typeof createDb>;
  let service!: ReturnType<typeof agentActionPolicyService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";
  let agentId = "";

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-agent-action-policy-");
    db = createDb(started.connectionString);
    service = agentActionPolicyService(db);
    tempDb = started;
  }, 120_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(companyAgentDefaults);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await closeDbClient(db);
    await tempDb?.cleanup();
  });

  async function seed() {
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Action Co",
      issuePrefix: `A${companyId.slice(0, 5).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Operator",
      role: "engineer",
      adapterType: "process",
      permissions: { canCreateAgents: false, retained: "yes" },
    });
  }

  it("uses the legacy outbound setting only for messages and public posts", async () => {
    await seed();
    await instanceSettingsService(db).updateGeneral({ outboundToolDraftMode: false });

    const policies = await service.listCompanyPolicies(companyId);
    expect(Object.fromEntries(policies.map((policy) => [policy.actionType, policy.mode]))).toEqual({
      send_message: "go_ahead",
      move_money: "ask_first",
      change_files: "ask_first",
      post_publicly: "go_ahead",
      change_knowledge_base: "ask_first",
    });
  });

  it("resolves agent override, then company value, then fallback", async () => {
    await seed();
    await service.updateCompanyPolicy(companyId, "move_money", "go_ahead");
    expect(await service.resolve({ companyId, agentId, actionType: "move_money" })).toBe("go_ahead");

    await service.updateAgentPolicy(agentId, "move_money", "ask_first");
    expect(await service.resolve({ companyId, agentId, actionType: "move_money" })).toBe("ask_first");

    await service.updateAgentPolicy(agentId, "move_money", null);
    expect(await service.resolve({ companyId, agentId, actionType: "move_money" })).toBe("go_ahead");
  });

  it("reports which policy layer supplied the resolved mode", async () => {
    await seed();
    expect(await service.resolveDetailed({ companyId, agentId, actionType: "send_message" }))
      .toEqual({ mode: "ask_first", source: "legacy" });
    expect(await service.resolveDetailed({ companyId, agentId, actionType: "change_files" }))
      .toEqual({ mode: "ask_first", source: "default" });

    await service.updateCompanyPolicy(companyId, "change_files", "go_ahead");
    expect(await service.resolveDetailed({ companyId, agentId, actionType: "change_files" }))
      .toEqual({ mode: "go_ahead", source: "company" });

    await service.updateAgentPolicy(agentId, "change_files", "ask_first");
    expect(await service.resolveDetailed({ companyId, agentId, actionType: "change_files" }))
      .toEqual({ mode: "ask_first", source: "agent" });
  });

  it("does not query the UUID column for a synthetic chat agent id", async () => {
    await seed();
    await expect(service.resolveDetailed({
      companyId,
      agentId: "clippy:user-1",
      actionType: "send_message",
    })).resolves.toEqual({ mode: "ask_first", source: "legacy" });
  });

  it("preserves unrelated company defaults and agent permissions", async () => {
    await seed();
    await db.insert(companyAgentDefaults).values({
      companyId,
      agentDefaults: { skipPermissionsByAdapterType: { claude_local: false }, retained: "yes" },
    });

    await service.updateCompanyPolicy(companyId, "change_files", "go_ahead");
    await service.updateAgentPolicy(agentId, "change_files", "go_ahead");

    const companyRow = await db.select().from(companyAgentDefaults);
    const agentRow = await db.select().from(agents);
    expect(companyRow[0]?.agentDefaults).toMatchObject({
      skipPermissionsByAdapterType: { claude_local: false },
      retained: "yes",
      actionApprovalModes: { change_files: "go_ahead" },
    });
    expect(agentRow[0]?.permissions).toMatchObject({
      canCreateAgents: false,
      retained: "yes",
      actionApprovalModes: { change_files: "go_ahead" },
    });
  });

  it("preserves concurrent updates to different action types", async () => {
    await seed();

    await Promise.all(
      AGENT_ACTION_TYPES.map((actionType) =>
        service.updateCompanyPolicy(companyId, actionType, "go_ahead"),
      ),
    );
    await Promise.all(
      AGENT_ACTION_TYPES.map((actionType) =>
        service.updateAgentPolicy(agentId, actionType, "go_ahead"),
      ),
    );

    const companyPolicies = await service.listCompanyPolicies(companyId);
    const agentPolicies = await service.listAgentPolicies(agentId);
    expect(companyPolicies.every((policy) => policy.mode === "go_ahead")).toBe(true);
    expect(agentPolicies?.overrides).toHaveLength(AGENT_ACTION_TYPES.length);
    expect(agentPolicies?.overrides.every((policy) => policy.mode === "go_ahead")).toBe(true);
  });

  it("keeps action overrides during an ordinary permission update", async () => {
    await seed();
    await service.updateAgentPolicy(agentId, "post_publicly", "go_ahead");

    await agentService(db).updatePermissions(agentId, { canCreateAgents: true });

    const policies = await service.listAgentPolicies(agentId);
    expect(policies?.overrides).toEqual([
      { companyId, agentId, actionType: "post_publicly", mode: "go_ahead" },
    ]);
  });

  it("updates every ordinary permission field without replacing action overrides", async () => {
    await seed();
    await service.updateAgentPolicy(agentId, "post_publicly", "go_ahead");

    await agentService(db).updatePermissions(agentId, {
      canCreateAgents: true,
      canCreateSkills: true,
      canAssignTasks: true,
      trustPreset: "low_trust_review",
      authorizationPolicy: { protectedAgent: { blockAssignment: true } },
    });

    const [agent] = await db.select().from(agents);
    expect(agent?.permissions).toMatchObject({
      canCreateAgents: true,
      canCreateSkills: true,
      canAssignTasks: true,
      trustPreset: "low_trust_review",
      authorizationPolicy: { protectedAgent: { blockAssignment: true } },
      actionApprovalModes: { post_publicly: "go_ahead" },
    });
  });

  it("keeps concurrent action and ordinary permission updates", async () => {
    await seed();

    await Promise.all([
      service.updateAgentPolicy(agentId, "change_files", "go_ahead"),
      agentService(db).updatePermissions(agentId, { canCreateAgents: true }),
    ]);

    const [agent] = await db.select().from(agents);
    expect(agent?.permissions).toMatchObject({
      canCreateAgents: true,
      retained: "yes",
      actionApprovalModes: { change_files: "go_ahead" },
    });
  });
});
