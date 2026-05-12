import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentTemplates,
  agents,
  companies,
  routineTemplates,
  routineTemplateTriggers,
  skillTemplates,
  templateDeployments,
} from "@paperclipai/db";
import type {
  AgentTemplate,
  AgentTemplateDetail,
  CreateAgentTemplate,
  CreateRoutineTemplate,
  CreateSkillTemplate,
  DeployTemplate,
  RoutineTemplate,
  RoutineTemplateDetail,
  RoutineTemplateTrigger,
  RoutineTemplateTriggerInput,
  RoutineVariable,
  SkillTemplate,
  SkillTemplateDetail,
  TemplateDeployment,
  TemplateDeploymentResult,
  TemplateDeploymentResultItem,
  TemplateType,
  UpdateAgentTemplate,
  UpdateRoutineTemplate,
  UpdateSkillTemplate,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { agentService } from "./agents.js";
import { companySkillService } from "./company-skills.js";
import { routineService } from "./routines.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

type Actor = { userId?: string | null };

type RoutineVariableInput = CreateRoutineTemplate["variables"][number];

function normalizeRoutineVariables(input: RoutineVariableInput[] | undefined): RoutineVariable[] {
  return (input ?? []).map((v) => ({
    name: v.name,
    label: v.label ?? null,
    type: v.type ?? "text",
    defaultValue: v.defaultValue ?? null,
    required: v.required ?? true,
    options: v.options ?? [],
  }));
}

export function templateService(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const routines = routineService(db, { pluginWorkerManager: options.pluginWorkerManager });
  const agentsSvc = agentService(db);
  const skills = companySkillService(db);

  async function listDeployments(type: TemplateType, templateId: string): Promise<TemplateDeployment[]> {
    const rows = await db
      .select({
        id: templateDeployments.id,
        templateType: templateDeployments.templateType,
        templateId: templateDeployments.templateId,
        companyId: templateDeployments.companyId,
        companyName: companies.name,
        deployedEntityId: templateDeployments.deployedEntityId,
        deployedAt: templateDeployments.deployedAt,
        deployedByUserId: templateDeployments.deployedByUserId,
        lastSyncedAt: templateDeployments.lastSyncedAt,
        metadata: templateDeployments.metadata,
      })
      .from(templateDeployments)
      .leftJoin(companies, eq(templateDeployments.companyId, companies.id))
      .where(
        and(
          eq(templateDeployments.templateType, type),
          eq(templateDeployments.templateId, templateId),
        ),
      )
      .orderBy(desc(templateDeployments.deployedAt));
    return rows.map((row) => ({
      id: row.id,
      templateType: row.templateType as TemplateType,
      templateId: row.templateId,
      companyId: row.companyId,
      companyName: row.companyName ?? undefined,
      deployedEntityId: row.deployedEntityId,
      deployedAt: row.deployedAt,
      deployedByUserId: row.deployedByUserId,
      lastSyncedAt: row.lastSyncedAt,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
    }));
  }

  async function recordDeployment(
    type: TemplateType,
    templateId: string,
    companyId: string,
    entityId: string,
    actor: Actor,
    metadata: Record<string, unknown> = {},
  ) {
    await db
      .insert(templateDeployments)
      .values({
        templateType: type,
        templateId,
        companyId,
        deployedEntityId: entityId,
        deployedByUserId: actor.userId ?? null,
        lastSyncedAt: new Date(),
        metadata,
      })
      .onConflictDoUpdate({
        target: [
          templateDeployments.templateType,
          templateDeployments.templateId,
          templateDeployments.companyId,
        ],
        set: {
          deployedEntityId: entityId,
          lastSyncedAt: new Date(),
          deployedByUserId: actor.userId ?? null,
          metadata,
        },
      });
  }

  async function getExistingDeployment(
    type: TemplateType,
    templateId: string,
    companyId: string,
  ): Promise<{ deployedEntityId: string | null } | null> {
    const row = await db
      .select({ deployedEntityId: templateDeployments.deployedEntityId })
      .from(templateDeployments)
      .where(
        and(
          eq(templateDeployments.templateType, type),
          eq(templateDeployments.templateId, templateId),
          eq(templateDeployments.companyId, companyId),
        ),
      )
      .limit(1);
    return row[0] ?? null;
  }

  function mapRoutineTemplate(row: typeof routineTemplates.$inferSelect): RoutineTemplate {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      routineTitle: row.routineTitle,
      routineDescription: row.routineDescription,
      priority: row.priority,
      concurrencyPolicy: row.concurrencyPolicy,
      catchUpPolicy: row.catchUpPolicy,
      variables: row.variables ?? [],
      defaultAssigneeRole: row.defaultAssigneeRole,
      createdByUserId: row.createdByUserId,
      updatedByUserId: row.updatedByUserId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  function mapAgentTemplate(row: typeof agentTemplates.$inferSelect): AgentTemplate {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      agentName: row.agentName,
      role: row.role,
      title: row.title,
      icon: row.icon,
      capabilities: row.capabilities,
      adapterType: row.adapterType,
      adapterConfig: (row.adapterConfig ?? {}) as Record<string, unknown>,
      runtimeConfig: (row.runtimeConfig ?? {}) as Record<string, unknown>,
      permissions: (row.permissions ?? {}) as Record<string, unknown>,
      forbiddenWritePaths: row.forbiddenWritePaths ?? [],
      budgetMonthlyCents: row.budgetMonthlyCents,
      createdByUserId: row.createdByUserId,
      updatedByUserId: row.updatedByUserId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  function mapSkillTemplate(row: typeof skillTemplates.$inferSelect): SkillTemplate {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      skillKey: row.skillKey,
      skillName: row.skillName,
      skillDescription: row.skillDescription,
      markdown: row.markdown,
      createdByUserId: row.createdByUserId,
      updatedByUserId: row.updatedByUserId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  function mapRoutineTemplateTrigger(
    row: typeof routineTemplateTriggers.$inferSelect,
  ): RoutineTemplateTrigger {
    return {
      id: row.id,
      templateId: row.templateId,
      kind: row.kind,
      label: row.label,
      enabled: row.enabled,
      cronExpression: row.cronExpression,
      timezone: row.timezone,
      signingMode: row.signingMode,
      replayWindowSec: row.replayWindowSec,
      sortOrder: row.sortOrder,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async function listRoutineTemplates(): Promise<RoutineTemplate[]> {
    const rows = await db
      .select()
      .from(routineTemplates)
      .orderBy(asc(routineTemplates.name));
    return rows.map(mapRoutineTemplate);
  }

  async function getRoutineTemplate(id: string): Promise<RoutineTemplateDetail | null> {
    const row = await db
      .select()
      .from(routineTemplates)
      .where(eq(routineTemplates.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const triggerRows = await db
      .select()
      .from(routineTemplateTriggers)
      .where(eq(routineTemplateTriggers.templateId, id))
      .orderBy(asc(routineTemplateTriggers.sortOrder), asc(routineTemplateTriggers.createdAt));
    const deployments = await listDeployments("routine", id);
    return {
      ...mapRoutineTemplate(row),
      triggers: triggerRows.map(mapRoutineTemplateTrigger),
      deployments,
    };
  }

  async function createRoutineTemplate(
    input: CreateRoutineTemplate,
    actor: Actor,
  ): Promise<RoutineTemplateDetail> {
    const [created] = await db
      .insert(routineTemplates)
      .values({
        name: input.name,
        description: input.description ?? null,
        routineTitle: input.routineTitle,
        routineDescription: input.routineDescription ?? null,
        priority: input.priority,
        concurrencyPolicy: input.concurrencyPolicy,
        catchUpPolicy: input.catchUpPolicy,
        variables: normalizeRoutineVariables(input.variables),
        defaultAssigneeRole: input.defaultAssigneeRole ?? null,
        createdByUserId: actor.userId ?? null,
        updatedByUserId: actor.userId ?? null,
      })
      .returning();
    if (!created) throw new Error("Failed to create routine template");
    if (input.triggers && input.triggers.length > 0) {
      await insertRoutineTemplateTriggers(created.id, input.triggers);
    }
    const detail = await getRoutineTemplate(created.id);
    if (!detail) throw new Error("Failed to read back created template");
    return detail;
  }

  async function insertRoutineTemplateTriggers(
    templateId: string,
    triggers: RoutineTemplateTriggerInput[],
  ) {
    if (triggers.length === 0) return;
    await db.insert(routineTemplateTriggers).values(
      triggers.map((t, idx) => ({
        templateId,
        kind: t.kind,
        label: t.label ?? null,
        enabled: t.enabled ?? true,
        cronExpression: t.kind === "schedule" ? t.cronExpression : null,
        timezone: t.kind === "schedule" ? (t.timezone || "UTC") : null,
        signingMode: t.kind === "webhook" ? (t.signingMode ?? "bearer") : null,
        replayWindowSec: t.kind === "webhook" ? (t.replayWindowSec ?? 300) : null,
        sortOrder: t.sortOrder ?? idx,
      })),
    );
  }

  async function updateRoutineTemplate(
    id: string,
    patch: UpdateRoutineTemplate,
    actor: Actor,
  ): Promise<RoutineTemplateDetail | null> {
    const existing = await db
      .select()
      .from(routineTemplates)
      .where(eq(routineTemplates.id, id))
      .then((rows) => rows[0] ?? null);
    if (!existing) return null;

    await db
      .update(routineTemplates)
      .set({
        name: patch.name ?? existing.name,
        description: patch.description === undefined ? existing.description : patch.description,
        routineTitle: patch.routineTitle ?? existing.routineTitle,
        routineDescription:
          patch.routineDescription === undefined ? existing.routineDescription : patch.routineDescription,
        priority: patch.priority ?? existing.priority,
        concurrencyPolicy: patch.concurrencyPolicy ?? existing.concurrencyPolicy,
        catchUpPolicy: patch.catchUpPolicy ?? existing.catchUpPolicy,
        variables:
          patch.variables === undefined
            ? existing.variables
            : normalizeRoutineVariables(patch.variables),
        defaultAssigneeRole:
          patch.defaultAssigneeRole === undefined ? existing.defaultAssigneeRole : patch.defaultAssigneeRole,
        updatedByUserId: actor.userId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(routineTemplates.id, id));

    if (patch.triggers !== undefined) {
      await db.delete(routineTemplateTriggers).where(eq(routineTemplateTriggers.templateId, id));
      if (patch.triggers.length > 0) {
        await insertRoutineTemplateTriggers(id, patch.triggers);
      }
    }
    return getRoutineTemplate(id);
  }

  async function deleteRoutineTemplate(id: string): Promise<boolean> {
    const result = await db
      .delete(routineTemplates)
      .where(eq(routineTemplates.id, id))
      .returning({ id: routineTemplates.id });
    return result.length > 0;
  }

  async function listAgentTemplates(): Promise<AgentTemplate[]> {
    const rows = await db
      .select()
      .from(agentTemplates)
      .orderBy(asc(agentTemplates.name));
    return rows.map(mapAgentTemplate);
  }

  async function getAgentTemplate(id: string): Promise<AgentTemplateDetail | null> {
    const row = await db
      .select()
      .from(agentTemplates)
      .where(eq(agentTemplates.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const deployments = await listDeployments("agent", id);
    return { ...mapAgentTemplate(row), deployments };
  }

  async function createAgentTemplate(
    input: CreateAgentTemplate,
    actor: Actor,
  ): Promise<AgentTemplateDetail> {
    const [created] = await db
      .insert(agentTemplates)
      .values({
        name: input.name,
        description: input.description ?? null,
        agentName: input.agentName,
        role: input.role,
        title: input.title ?? null,
        icon: input.icon ?? null,
        capabilities: input.capabilities ?? null,
        adapterType: input.adapterType,
        adapterConfig: input.adapterConfig,
        runtimeConfig: input.runtimeConfig,
        permissions: input.permissions,
        forbiddenWritePaths: input.forbiddenWritePaths,
        budgetMonthlyCents: input.budgetMonthlyCents,
        createdByUserId: actor.userId ?? null,
        updatedByUserId: actor.userId ?? null,
      })
      .returning();
    if (!created) throw new Error("Failed to create agent template");
    const detail = await getAgentTemplate(created.id);
    if (!detail) throw new Error("Failed to read back created template");
    return detail;
  }

  async function updateAgentTemplate(
    id: string,
    patch: UpdateAgentTemplate,
    actor: Actor,
  ): Promise<AgentTemplateDetail | null> {
    const existing = await db
      .select()
      .from(agentTemplates)
      .where(eq(agentTemplates.id, id))
      .then((rows) => rows[0] ?? null);
    if (!existing) return null;
    await db
      .update(agentTemplates)
      .set({
        name: patch.name ?? existing.name,
        description: patch.description === undefined ? existing.description : patch.description,
        agentName: patch.agentName ?? existing.agentName,
        role: patch.role ?? existing.role,
        title: patch.title === undefined ? existing.title : patch.title,
        icon: patch.icon === undefined ? existing.icon : patch.icon,
        capabilities: patch.capabilities === undefined ? existing.capabilities : patch.capabilities,
        adapterType: patch.adapterType ?? existing.adapterType,
        adapterConfig: patch.adapterConfig ?? existing.adapterConfig,
        runtimeConfig: patch.runtimeConfig ?? existing.runtimeConfig,
        permissions: patch.permissions ?? existing.permissions,
        forbiddenWritePaths: patch.forbiddenWritePaths ?? existing.forbiddenWritePaths,
        budgetMonthlyCents: patch.budgetMonthlyCents ?? existing.budgetMonthlyCents,
        updatedByUserId: actor.userId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(agentTemplates.id, id));
    return getAgentTemplate(id);
  }

  async function deleteAgentTemplate(id: string): Promise<boolean> {
    const result = await db
      .delete(agentTemplates)
      .where(eq(agentTemplates.id, id))
      .returning({ id: agentTemplates.id });
    return result.length > 0;
  }

  async function listSkillTemplates(): Promise<SkillTemplate[]> {
    const rows = await db
      .select()
      .from(skillTemplates)
      .orderBy(asc(skillTemplates.name));
    return rows.map(mapSkillTemplate);
  }

  async function getSkillTemplate(id: string): Promise<SkillTemplateDetail | null> {
    const row = await db
      .select()
      .from(skillTemplates)
      .where(eq(skillTemplates.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const deployments = await listDeployments("skill", id);
    return { ...mapSkillTemplate(row), deployments };
  }

  async function createSkillTemplate(
    input: CreateSkillTemplate,
    actor: Actor,
  ): Promise<SkillTemplateDetail> {
    const existing = await db
      .select({ id: skillTemplates.id })
      .from(skillTemplates)
      .where(eq(skillTemplates.skillKey, input.skillKey))
      .limit(1);
    if (existing.length > 0) {
      throw conflict(`Skill template with skillKey '${input.skillKey}' already exists`);
    }
    const [created] = await db
      .insert(skillTemplates)
      .values({
        name: input.name,
        description: input.description ?? null,
        skillKey: input.skillKey,
        skillName: input.skillName,
        skillDescription: input.skillDescription ?? null,
        markdown: input.markdown,
        createdByUserId: actor.userId ?? null,
        updatedByUserId: actor.userId ?? null,
      })
      .returning();
    if (!created) throw new Error("Failed to create skill template");
    const detail = await getSkillTemplate(created.id);
    if (!detail) throw new Error("Failed to read back created template");
    return detail;
  }

  async function updateSkillTemplate(
    id: string,
    patch: UpdateSkillTemplate,
    actor: Actor,
  ): Promise<SkillTemplateDetail | null> {
    const existing = await db
      .select()
      .from(skillTemplates)
      .where(eq(skillTemplates.id, id))
      .then((rows) => rows[0] ?? null);
    if (!existing) return null;
    if (patch.skillKey && patch.skillKey !== existing.skillKey) {
      const dupe = await db
        .select({ id: skillTemplates.id })
        .from(skillTemplates)
        .where(eq(skillTemplates.skillKey, patch.skillKey))
        .limit(1);
      if (dupe.length > 0) {
        throw conflict(`Skill template with skillKey '${patch.skillKey}' already exists`);
      }
    }
    await db
      .update(skillTemplates)
      .set({
        name: patch.name ?? existing.name,
        description: patch.description === undefined ? existing.description : patch.description,
        skillKey: patch.skillKey ?? existing.skillKey,
        skillName: patch.skillName ?? existing.skillName,
        skillDescription:
          patch.skillDescription === undefined ? existing.skillDescription : patch.skillDescription,
        markdown: patch.markdown ?? existing.markdown,
        updatedByUserId: actor.userId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(skillTemplates.id, id));
    return getSkillTemplate(id);
  }

  async function deleteSkillTemplate(id: string): Promise<boolean> {
    const result = await db
      .delete(skillTemplates)
      .where(eq(skillTemplates.id, id))
      .returning({ id: skillTemplates.id });
    return result.length > 0;
  }

  async function deployRoutine(
    templateId: string,
    body: DeployTemplate,
    actor: Actor,
  ): Promise<TemplateDeploymentResult> {
    const template = await getRoutineTemplate(templateId);
    if (!template) throw notFound("Routine template not found");
    const companyRows = await db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(inArray(companies.id, body.companyIds));
    const companyMap = new Map(companyRows.map((c) => [c.id, c.name]));
    const results: TemplateDeploymentResultItem[] = [];

    for (const companyId of body.companyIds) {
      const companyName = companyMap.get(companyId) ?? companyId;
      if (!companyMap.has(companyId)) {
        results.push({
          companyId,
          companyName,
          status: "error",
          deployedEntityId: null,
          message: "Company not found",
        });
        continue;
      }

      if (body.skipExisting) {
        const existing = await getExistingDeployment("routine", templateId, companyId);
        if (existing?.deployedEntityId) {
          results.push({
            companyId,
            companyName,
            status: "skipped",
            deployedEntityId: existing.deployedEntityId,
            message: "Already deployed",
          });
          continue;
        }
      }

      try {
        let assigneeAgentId: string | null = null;
        if (template.defaultAssigneeRole) {
          const candidate = await db
            .select({ id: agents.id })
            .from(agents)
            .where(
              and(
                eq(agents.companyId, companyId),
                eq(agents.role, template.defaultAssigneeRole),
              ),
            )
            .limit(1);
          assigneeAgentId = candidate[0]?.id ?? null;
        }

        const routine = await routines.create(
          companyId,
          {
            title: template.routineTitle,
            description: template.routineDescription ?? null,
            assigneeAgentId,
            priority: template.priority as CreateRoutineTemplate["priority"],
            status: assigneeAgentId ? "active" : "paused",
            concurrencyPolicy: template.concurrencyPolicy as CreateRoutineTemplate["concurrencyPolicy"],
            catchUpPolicy: template.catchUpPolicy as CreateRoutineTemplate["catchUpPolicy"],
            variables: template.variables,
          },
          { agentId: null, userId: actor.userId ?? null },
        );

        for (const trigger of template.triggers) {
          if (trigger.kind === "schedule") {
            await routines.createTrigger(
              routine.id,
              {
                kind: "schedule",
                label: trigger.label ?? null,
                enabled: trigger.enabled,
                cronExpression: trigger.cronExpression ?? "0 9 * * *",
                timezone: trigger.timezone ?? "UTC",
              },
              { agentId: null, userId: actor.userId ?? null },
            );
          } else if (trigger.kind === "webhook") {
            await routines.createTrigger(
              routine.id,
              {
                kind: "webhook",
                label: trigger.label ?? null,
                enabled: trigger.enabled,
                signingMode: (trigger.signingMode ?? "bearer") as "bearer" | "hmac_sha256",
                replayWindowSec: trigger.replayWindowSec ?? 300,
              },
              { agentId: null, userId: actor.userId ?? null },
            );
          } else if (trigger.kind === "api") {
            await routines.createTrigger(
              routine.id,
              {
                kind: "api",
                label: trigger.label ?? null,
                enabled: trigger.enabled,
              },
              { agentId: null, userId: actor.userId ?? null },
            );
          }
        }

        await recordDeployment("routine", templateId, companyId, routine.id, actor, {
          assigneeAgentId,
        });
        results.push({
          companyId,
          companyName,
          status: "created",
          deployedEntityId: routine.id,
          message: assigneeAgentId
            ? null
            : `No agent with role '${template.defaultAssigneeRole ?? "?"}' in target company; routine created in paused state`,
        });
      } catch (err) {
        results.push({
          companyId,
          companyName,
          status: "error",
          deployedEntityId: null,
          message: err instanceof Error ? err.message : "Deployment failed",
        });
      }
    }

    return { templateType: "routine", templateId, results };
  }

  async function deployAgent(
    templateId: string,
    body: DeployTemplate,
    actor: Actor,
  ): Promise<TemplateDeploymentResult> {
    const template = await getAgentTemplate(templateId);
    if (!template) throw notFound("Agent template not found");
    const companyRows = await db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(inArray(companies.id, body.companyIds));
    const companyMap = new Map(companyRows.map((c) => [c.id, c.name]));
    const results: TemplateDeploymentResultItem[] = [];

    for (const companyId of body.companyIds) {
      const companyName = companyMap.get(companyId) ?? companyId;
      if (!companyMap.has(companyId)) {
        results.push({
          companyId,
          companyName,
          status: "error",
          deployedEntityId: null,
          message: "Company not found",
        });
        continue;
      }

      if (body.skipExisting) {
        const existing = await getExistingDeployment("agent", templateId, companyId);
        if (existing?.deployedEntityId) {
          results.push({
            companyId,
            companyName,
            status: "skipped",
            deployedEntityId: existing.deployedEntityId,
            message: "Already deployed",
          });
          continue;
        }
      }

      try {
        const agent = await agentsSvc.create(companyId, {
          name: template.agentName,
          role: template.role,
          title: template.title ?? null,
          icon: template.icon ?? null,
          capabilities: template.capabilities ?? null,
          adapterType: template.adapterType,
          adapterConfig: template.adapterConfig,
          runtimeConfig: template.runtimeConfig,
          permissions: template.permissions,
          forbiddenWritePaths: template.forbiddenWritePaths,
          budgetMonthlyCents: template.budgetMonthlyCents,
        });
        await recordDeployment("agent", templateId, companyId, agent.id, actor);
        results.push({
          companyId,
          companyName,
          status: "created",
          deployedEntityId: agent.id,
          message: agent.name !== template.agentName
            ? `Renamed to '${agent.name}' due to shortname collision in target company`
            : null,
        });
      } catch (err) {
        results.push({
          companyId,
          companyName,
          status: "error",
          deployedEntityId: null,
          message: err instanceof Error ? err.message : "Deployment failed",
        });
      }
    }

    return { templateType: "agent", templateId, results };
  }

  async function deploySkill(
    templateId: string,
    body: DeployTemplate,
    actor: Actor,
  ): Promise<TemplateDeploymentResult> {
    const template = await getSkillTemplate(templateId);
    if (!template) throw notFound("Skill template not found");
    const companyRows = await db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(inArray(companies.id, body.companyIds));
    const companyMap = new Map(companyRows.map((c) => [c.id, c.name]));
    const results: TemplateDeploymentResultItem[] = [];

    for (const companyId of body.companyIds) {
      const companyName = companyMap.get(companyId) ?? companyId;
      if (!companyMap.has(companyId)) {
        results.push({
          companyId,
          companyName,
          status: "error",
          deployedEntityId: null,
          message: "Company not found",
        });
        continue;
      }

      if (body.skipExisting) {
        const existing = await getExistingDeployment("skill", templateId, companyId);
        if (existing?.deployedEntityId) {
          results.push({
            companyId,
            companyName,
            status: "skipped",
            deployedEntityId: existing.deployedEntityId,
            message: "Already deployed",
          });
          continue;
        }
      }

      try {
        const skill = await skills.createLocalSkill(companyId, {
          name: template.skillName,
          slug: template.skillKey,
          description: template.skillDescription ?? null,
          markdown: template.markdown,
        });
        await recordDeployment("skill", templateId, companyId, skill.id, actor);
        results.push({
          companyId,
          companyName,
          status: "created",
          deployedEntityId: skill.id,
          message: null,
        });
      } catch (err) {
        results.push({
          companyId,
          companyName,
          status: "error",
          deployedEntityId: null,
          message: err instanceof Error ? err.message : "Deployment failed",
        });
      }
    }

    return { templateType: "skill", templateId, results };
  }

  async function deploy(
    type: TemplateType,
    templateId: string,
    body: DeployTemplate,
    actor: Actor,
  ): Promise<TemplateDeploymentResult> {
    if (type === "routine") return deployRoutine(templateId, body, actor);
    if (type === "agent") return deployAgent(templateId, body, actor);
    if (type === "skill") return deploySkill(templateId, body, actor);
    throw unprocessable(`Unknown template type: ${type}`);
  }

  return {
    listRoutineTemplates,
    getRoutineTemplate,
    createRoutineTemplate,
    updateRoutineTemplate,
    deleteRoutineTemplate,
    listAgentTemplates,
    getAgentTemplate,
    createAgentTemplate,
    updateAgentTemplate,
    deleteAgentTemplate,
    listSkillTemplates,
    getSkillTemplate,
    createSkillTemplate,
    updateSkillTemplate,
    deleteSkillTemplate,
    deploy,
    listDeployments,
  };
}
