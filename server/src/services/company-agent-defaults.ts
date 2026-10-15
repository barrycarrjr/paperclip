import type { Db } from "@paperclipai/db";
import { companyAgentDefaults } from "@paperclipai/db";
import {
  companyAgentDefaultsSchema,
  mergeActionApprovalModes,
  mergeSkipPermissionsByAdapterType,
  resolveAgentSkipPermissions,
  type CompanyAgentDefaults,
  type InstanceAgentDefaults,
  type PatchCompanyAgentDefaults,
  type ResolvedAgentPermission,
} from "@paperclipai/shared";
import { eq, sql } from "drizzle-orm";
import { instanceSettingsService } from "./instance-settings.js";

function normalizeCompanyAgentDefaults(raw: unknown): CompanyAgentDefaults {
  const parsed = companyAgentDefaultsSchema.safeParse(raw ?? {});
  if (parsed.success) {
    return {
      skipPermissionsByAdapterType: parsed.data.skipPermissionsByAdapterType ?? {},
      actionApprovalModes: parsed.data.actionApprovalModes ?? {},
    };
  }
  return { skipPermissionsByAdapterType: {}, actionApprovalModes: {} };
}

export function companyAgentDefaultsService(db: Db) {
  const instanceSettings = instanceSettingsService(db);

  async function get(companyId: string): Promise<CompanyAgentDefaults> {
    const row = await db
      .select()
      .from(companyAgentDefaults)
      .where(eq(companyAgentDefaults.companyId, companyId))
      .then((rows) => rows[0] ?? null);
    return normalizeCompanyAgentDefaults(row?.agentDefaults);
  }

  return {
    get,

    update: async (
      companyId: string,
      patch: PatchCompanyAgentDefaults,
    ): Promise<{ previous: CompanyAgentDefaults; next: CompanyAgentDefaults }> => {
      const previous = await get(companyId);
      const next = normalizeCompanyAgentDefaults({
        ...previous,
        skipPermissionsByAdapterType: mergeSkipPermissionsByAdapterType(
          previous.skipPermissionsByAdapterType,
          patch.skipPermissionsByAdapterType,
        ),
        actionApprovalModes: mergeActionApprovalModes(
          previous.actionApprovalModes,
          patch.actionApprovalModes,
        ),
      });
      const now = new Date();
      const stored = sql`coalesce(${companyAgentDefaults.agentDefaults}, '{}'::jsonb)`;
      let nextSkipPermissions = sql`case
        when jsonb_typeof(${companyAgentDefaults.agentDefaults}->'skipPermissionsByAdapterType') = 'object'
          then ${companyAgentDefaults.agentDefaults}->'skipPermissionsByAdapterType'
        else '{}'::jsonb
      end`;
      for (const [adapterType, value] of Object.entries(patch.skipPermissionsByAdapterType ?? {})) {
        nextSkipPermissions = value === null
          ? sql`(${nextSkipPermissions}) - ${adapterType}::text`
          : sql`(${nextSkipPermissions}) || jsonb_build_object(${adapterType}::text, ${value}::boolean)`;
      }
      let nextActionModes = sql`case
        when jsonb_typeof(${companyAgentDefaults.agentDefaults}->'actionApprovalModes') = 'object'
          then ${companyAgentDefaults.agentDefaults}->'actionApprovalModes'
        else '{}'::jsonb
      end`;
      for (const [actionType, mode] of Object.entries(patch.actionApprovalModes ?? {})) {
        nextActionModes = mode === null
          ? sql`(${nextActionModes}) - ${actionType}::text`
          : sql`(${nextActionModes}) || jsonb_build_object(${actionType}::text, ${mode}::text)`;
      }
      const mergedStored = sql`jsonb_set(
        jsonb_set(
          ${stored},
          '{skipPermissionsByAdapterType}',
          ${nextSkipPermissions},
          true
        ),
        '{actionApprovalModes}',
        ${nextActionModes},
        true
      )`;
      await db
        .insert(companyAgentDefaults)
        .values({ companyId, agentDefaults: { ...next }, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: [companyAgentDefaults.companyId],
          set: { agentDefaults: mergedStored, updatedAt: now },
        });
      return { previous, next };
    },

    /**
     * Fill in the inherited run-permission value when the agent's own
     * adapterConfig leaves it unset. Mutates and returns `config`.
     */
    applyRunPermissionDefault: async (input: {
      companyId: string;
      adapterType: string;
      config: Record<string, unknown>;
      instanceAgentDefaults?: InstanceAgentDefaults;
    }): Promise<ResolvedAgentPermission | null> => {
      const resolved = resolveAgentSkipPermissions({
        adapterType: input.adapterType,
        adapterConfig: input.config,
        companyDefaults: await get(input.companyId),
        instanceDefaults: input.instanceAgentDefaults ?? (await instanceSettings.getAgentDefaults()),
      });
      if (resolved && resolved.source !== "agent") {
        input.config[resolved.configKey] = resolved.skipPermissions;
      }
      return resolved;
    },
  };
}
