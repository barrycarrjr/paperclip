import type { Db } from "@paperclipai/db";
import { agents, companyAgentDefaults } from "@paperclipai/db";
import {
  AGENT_ACTION_MODES,
  AGENT_ACTION_TYPES,
  type AgentActionMode,
  type AgentActionPolicyOverride,
  type AgentActionType,
  type CompanyActionPolicy,
  type EffectiveAgentActionPolicy,
  isUuidLike,
} from "@paperclipai/shared";
import { eq, sql } from "drizzle-orm";
import { instanceSettingsService } from "./instance-settings.js";

type ActionApprovalModes = Partial<Record<AgentActionType, AgentActionMode>>;

export interface ResolvedAgentActionPolicy {
  mode: AgentActionMode;
  source: "agent" | "company" | "legacy" | "default";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isActionMode(value: unknown): value is AgentActionMode {
  return (AGENT_ACTION_MODES as readonly unknown[]).includes(value);
}

function readActionApprovalModes(value: unknown): ActionApprovalModes {
  if (!isRecord(value)) return {};
  const rawModes = value.actionApprovalModes;
  if (!isRecord(rawModes)) return {};

  const modes: ActionApprovalModes = {};
  for (const actionType of AGENT_ACTION_TYPES) {
    const mode = rawModes[actionType];
    if (isActionMode(mode)) modes[actionType] = mode;
  }
  return modes;
}

function fallbackMode(actionType: AgentActionType, outboundToolDraftMode: boolean): AgentActionMode {
  if (actionType === "send_message" || actionType === "post_publicly") {
    return outboundToolDraftMode ? "ask_first" : "go_ahead";
  }
  return "ask_first";
}

export function agentActionPolicyService(db: Db) {
  const instanceSettings = instanceSettingsService(db);

  async function storedCompanyModes(companyId: string): Promise<ActionApprovalModes> {
    const row = await db
      .select({ agentDefaults: companyAgentDefaults.agentDefaults })
      .from(companyAgentDefaults)
      .where(eq(companyAgentDefaults.companyId, companyId))
      .then((rows) => rows[0] ?? null);
    return readActionApprovalModes(row?.agentDefaults);
  }

  async function companyPolicies(companyId: string): Promise<CompanyActionPolicy[]> {
    const [stored, general] = await Promise.all([
      storedCompanyModes(companyId),
      instanceSettings.getGeneral(),
    ]);
    return AGENT_ACTION_TYPES.map((actionType) => ({
      companyId,
      actionType,
      mode: stored[actionType] ?? fallbackMode(actionType, general.outboundToolDraftMode),
    }));
  }

  async function getAgentRecord(agentId: string) {
    return db
      .select({ id: agents.id, companyId: agents.companyId, permissions: agents.permissions })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function agentPolicies(agentId: string): Promise<{
    overrides: AgentActionPolicyOverride[];
    effective: EffectiveAgentActionPolicy[];
  } | null> {
    const agent = await getAgentRecord(agentId);
    if (!agent) return null;

    const [companies, overridesByType] = await Promise.all([
      companyPolicies(agent.companyId),
      Promise.resolve(readActionApprovalModes(agent.permissions)),
    ]);
    const overrides = AGENT_ACTION_TYPES.flatMap((actionType) => {
      const mode = overridesByType[actionType];
      return mode ? [{ companyId: agent.companyId, agentId, actionType, mode }] : [];
    });
    const effective = companies.map((companyPolicy) => {
      const overrideMode = overridesByType[companyPolicy.actionType] ?? null;
      return {
        companyId: agent.companyId,
        agentId,
        actionType: companyPolicy.actionType,
        companyMode: companyPolicy.mode,
        overrideMode,
        effectiveMode: overrideMode ?? companyPolicy.mode,
        source: overrideMode ? "agent" as const : "company" as const,
      };
    });
    return { overrides, effective };
  }

  async function resolveDetailed(input: {
    companyId: string;
    agentId?: string | null;
    actionType: AgentActionType;
  }): Promise<ResolvedAgentActionPolicy> {
    if (typeof input.agentId === "string" && isUuidLike(input.agentId)) {
      const agent = await getAgentRecord(input.agentId);
      if (agent?.companyId === input.companyId) {
        const override = readActionApprovalModes(agent.permissions)[input.actionType];
        if (override) return { mode: override, source: "agent" };
      }
    }
    const stored = await storedCompanyModes(input.companyId);
    const companyMode = stored[input.actionType];
    if (companyMode) return { mode: companyMode, source: "company" };

    const general = await instanceSettings.getGeneral();
    const mode = fallbackMode(input.actionType, general.outboundToolDraftMode);
    const source = input.actionType === "send_message" || input.actionType === "post_publicly"
      ? "legacy" as const
      : "default" as const;
    return { mode, source };
  }

  return {
    listCompanyPolicies: companyPolicies,

    updateCompanyPolicy: async (companyId: string, actionType: AgentActionType, mode: AgentActionMode) => {
      const previous = await companyPolicies(companyId);
      const now = new Date();
      await db
        .insert(companyAgentDefaults)
        .values({
          companyId,
          agentDefaults: { actionApprovalModes: { [actionType]: mode } },
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [companyAgentDefaults.companyId],
          set: {
            agentDefaults: sql`jsonb_set(
              coalesce(${companyAgentDefaults.agentDefaults}, '{}'::jsonb),
              '{actionApprovalModes}',
              (case
                when jsonb_typeof(${companyAgentDefaults.agentDefaults}->'actionApprovalModes') = 'object'
                  then ${companyAgentDefaults.agentDefaults}->'actionApprovalModes'
                else '{}'::jsonb
              end) || jsonb_build_object(${actionType}::text, ${mode}::text),
              true
            )`,
            updatedAt: now,
          },
        });
      return { previous, next: await companyPolicies(companyId) };
    },

    listAgentPolicies: agentPolicies,

    updateAgentPolicy: async (
      agentId: string,
      actionType: AgentActionType,
      mode: AgentActionMode | null,
    ) => {
      const previous = await agentPolicies(agentId);
      if (!previous) return null;
      const currentModes = sql`case
        when jsonb_typeof(${agents.permissions}->'actionApprovalModes') = 'object'
          then ${agents.permissions}->'actionApprovalModes'
        else '{}'::jsonb
      end`;
      const nextModes = mode === null
        ? sql`${currentModes} - ${actionType}::text`
        : sql`${currentModes} || jsonb_build_object(${actionType}::text, ${mode}::text)`;
      await db
        .update(agents)
        .set({
          permissions: sql`jsonb_set(
            coalesce(${agents.permissions}, '{}'::jsonb),
            '{actionApprovalModes}',
            ${nextModes},
            true
          )`,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, agentId));
      return { previous, next: await agentPolicies(agentId) };
    },

    resolveDetailed,
    resolve: async (input: {
      companyId: string;
      agentId?: string | null;
      actionType: AgentActionType;
    }): Promise<AgentActionMode> => (await resolveDetailed(input)).mode,
  };
}
