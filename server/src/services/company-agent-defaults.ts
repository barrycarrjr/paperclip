import type { Db } from "@paperclipai/db";
import { companyAgentDefaults } from "@paperclipai/db";
import {
  companyAgentDefaultsSchema,
  mergeSkipPermissionsByAdapterType,
  resolveAgentSkipPermissions,
  type CompanyAgentDefaults,
  type InstanceAgentDefaults,
  type PatchCompanyAgentDefaults,
  type ResolvedAgentPermission,
} from "@paperclipai/shared";
import { eq } from "drizzle-orm";
import { instanceSettingsService } from "./instance-settings.js";

function normalizeCompanyAgentDefaults(raw: unknown): CompanyAgentDefaults {
  const parsed = companyAgentDefaultsSchema.safeParse(raw ?? {});
  if (parsed.success) {
    return { skipPermissionsByAdapterType: parsed.data.skipPermissionsByAdapterType ?? {} };
  }
  return { skipPermissionsByAdapterType: {} };
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
      });
      const now = new Date();
      await db
        .insert(companyAgentDefaults)
        .values({ companyId, agentDefaults: { ...next }, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: [companyAgentDefaults.companyId],
          set: { agentDefaults: { ...next }, updatedAt: now },
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
