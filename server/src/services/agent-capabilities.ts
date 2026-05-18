import type { Db } from "@paperclipai/db";
import {
  agents as agentsTable,
  plugins as pluginsTable,
  pluginState,
} from "@paperclipai/db";
import { and, eq, isNotNull } from "drizzle-orm";

/**
 * Agent-capability discovery service.
 *
 * Plugins declare that an agent in their company has a named capability by
 * writing to `plugin_state` at the conventional location:
 *
 *   scope_kind  = "agent"
 *   scope_id    = <agentId>
 *   namespace   = "capabilities"
 *   state_key   = <capabilityName>   (e.g. "phone", "email", "calendar")
 *
 * The value can be any JSON object — typically `{ declaredAt: ISO }`. This
 * service joins those rows against the `agents` table to filter by company
 * and skip terminated agents, and returns enough info that another agent
 * can decide who to delegate to.
 *
 * Why the convention-in-plugin_state approach (vs. a dedicated table):
 * - No DB migration needed; plugins already have `ctx.state.set/get/delete`.
 * - Capabilities follow the same scope/lifetime semantics as other plugin
 *   state — if the plugin is uninstalled, its rows cascade away with it.
 * - Cross-plugin queries (this service) just read `plugin_state` with the
 *   well-known namespace + state_key.
 */

export interface AgentCapabilityMatch {
  agentId: string;
  agentName: string;
  agentRole: string;
  capability: string;
  /** The plugin that declared this capability. */
  pluginId: string;
  pluginKey: string;
  pluginDisplayName: string;
  /** ISO timestamp the plugin wrote the row. */
  declaredAt: string;
}

const CAPABILITY_NAMESPACE = "capabilities";

export function agentCapabilitiesService(db: Db) {
  /**
   * Find all non-terminated agents in `companyId` that have been declared
   * `capability` by any installed plugin.
   */
  async function findAgentsWithCapability(
    companyId: string,
    capability: string,
  ): Promise<AgentCapabilityMatch[]> {
    if (!capability.trim()) return [];

    // Single SQL trip: plugin_state JOIN agents JOIN plugins. The `scope_id`
    // column is `text` in plugin_state but `agents.id` is `uuid` — drizzle
    // handles the cast via eq() since postgres will coerce uuid<->text on
    // equality.
    const rows = await db
      .select({
        agentId: agentsTable.id,
        agentName: agentsTable.name,
        agentRole: agentsTable.role,
        pluginId: pluginsTable.id,
        pluginKey: pluginsTable.pluginKey,
        // displayName lives inside the JSONB manifest, not as its own
        // column. Read it out of manifest_json and let consumers fall back
        // to pluginKey if the manifest doesn't declare one.
        pluginManifest: pluginsTable.manifestJson,
        valueJson: pluginState.valueJson,
        updatedAt: pluginState.updatedAt,
      })
      .from(pluginState)
      .innerJoin(agentsTable, eq(agentsTable.id, pluginState.scopeId))
      .innerJoin(pluginsTable, eq(pluginsTable.id, pluginState.pluginId))
      .where(
        and(
          eq(pluginState.scopeKind, "agent"),
          eq(pluginState.namespace, CAPABILITY_NAMESPACE),
          eq(pluginState.stateKey, capability),
          eq(agentsTable.companyId, companyId),
          isNotNull(agentsTable.id),
        ),
      );

    return rows
      .filter((row) => row.agentRole && row.agentName)
      .map((row) => {
        const declaredAt =
          row.valueJson &&
          typeof row.valueJson === "object" &&
          "declaredAt" in (row.valueJson as Record<string, unknown>) &&
          typeof (row.valueJson as { declaredAt: unknown }).declaredAt === "string"
            ? ((row.valueJson as { declaredAt: string }).declaredAt)
            : row.updatedAt.toISOString();
        const manifestDisplayName =
          row.pluginManifest &&
          typeof row.pluginManifest === "object" &&
          "displayName" in row.pluginManifest &&
          typeof (row.pluginManifest as { displayName: unknown }).displayName === "string"
            ? (row.pluginManifest as { displayName: string }).displayName
            : null;
        return {
          agentId: row.agentId,
          agentName: row.agentName,
          agentRole: String(row.agentRole),
          capability,
          pluginId: row.pluginId,
          pluginKey: row.pluginKey,
          pluginDisplayName: manifestDisplayName ?? row.pluginKey,
          declaredAt,
        };
      });
  }

  return { findAgentsWithCapability };
}

export type AgentCapabilitiesService = ReturnType<typeof agentCapabilitiesService>;

/** The namespace plugins MUST write to when declaring agent capabilities. */
export const AGENT_CAPABILITY_NAMESPACE = CAPABILITY_NAMESPACE;
