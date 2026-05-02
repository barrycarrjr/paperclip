/**
 * External MCP tool source — discovery loop that asks each registered MCP
 * server for its tool list (via the manager) and returns descriptors that
 * the dispatcher merges with the plugin tool registry.
 *
 * The dispatcher namespaces external MCP tools as `mcp:<server.key>:<tool>`.
 * Tool name parsing happens in the dispatcher; this module only concerns
 * itself with the discovery side.
 *
 * Discovery is done per (server, callerCompanyId) so allow-lists and
 * mutation gates can be enforced at the right granularity. Cache lifetime
 * is short — we want config edits to take effect immediately.
 */

import type { Db } from "@paperclipai/db";
import { externalMcpServers } from "@paperclipai/db";
import { EXTERNAL_MCP_TOOL_NAMESPACE, isCompanyAllowed } from "@paperclipai/shared";
import type { ExternalMcpServerRecord } from "@paperclipai/shared";
import type { ExternalMcpServerManager, ExternalMcpToolDescriptor } from "./external-mcp-server-manager.js";
import { logger } from "../middleware/logger.js";

export interface ExternalMcpAggregatedTool extends ExternalMcpToolDescriptor {
  serverId: string;
  serverKey: string;
  /** Fully namespaced name: `mcp:<serverKey>:<toolName>`. */
  namespacedName: string;
}

export interface ExternalMcpToolSource {
  /**
   * List all tools visible to the calling company across every registered
   * MCP server the company is allowed to use.
   */
  listToolsForCompany(companyId: string): Promise<ExternalMcpAggregatedTool[]>;

  /**
   * List servers the operator has registered. Board-only callers can pass
   * `companyId === null` to bypass the allowedCompanies filter.
   */
  listServers(companyId: string | null): Promise<ExternalMcpServerRecord[]>;

  /** Build the namespaced tool ID for a (server, tool) pair. */
  buildNamespacedName(serverKey: string, toolName: string): string;

  /** Parse `mcp:<server>:<tool>` into its parts; returns null on miss. */
  parseNamespacedName(namespaced: string): { serverKey: string; toolName: string } | null;
}

function dbRowToRecord(
  row: typeof externalMcpServers.$inferSelect,
): ExternalMcpServerRecord {
  return {
    id: row.id,
    key: row.key,
    displayName: row.displayName,
    description: row.description,
    transport: row.transport,
    command: row.command,
    args: row.args,
    url: row.url,
    envBindings: row.envBindings ?? {},
    headerBindings: row.headerBindings ?? {},
    allowedCompanies: row.allowedCompanies ?? [],
    allowMutations: row.allowMutations,
    writeAllowList: row.writeAllowList ?? [],
    toolAllowList: row.toolAllowList ?? [],
    toolDenyList: row.toolDenyList ?? [],
    lastError: row.lastError,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createExternalMcpToolSource(
  db: Db,
  manager: ExternalMcpServerManager,
): ExternalMcpToolSource {
  const log = logger.child({ service: "external-mcp-tool-source" });

  function buildNamespacedName(serverKey: string, toolName: string): string {
    return `${EXTERNAL_MCP_TOOL_NAMESPACE}:${serverKey}:${toolName}`;
  }

  function parseNamespacedName(name: string): { serverKey: string; toolName: string } | null {
    const prefix = `${EXTERNAL_MCP_TOOL_NAMESPACE}:`;
    if (!name.startsWith(prefix)) return null;
    const rest = name.slice(prefix.length);
    const sep = rest.indexOf(":");
    if (sep <= 0 || sep >= rest.length - 1) return null;
    return {
      serverKey: rest.slice(0, sep),
      toolName: rest.slice(sep + 1),
    };
  }

  async function listServers(companyId: string | null): Promise<ExternalMcpServerRecord[]> {
    const rows = await db.select().from(externalMcpServers);
    const records = rows.map(dbRowToRecord);
    if (companyId === null) return records;
    return records.filter((r) => isCompanyAllowed(r.allowedCompanies, companyId));
  }

  async function listToolsForCompany(companyId: string): Promise<ExternalMcpAggregatedTool[]> {
    const servers = await listServers(companyId);
    const out: ExternalMcpAggregatedTool[] = [];

    for (const server of servers) {
      try {
        const tools = await manager.listTools(server.id, companyId);
        for (const tool of tools) {
          out.push({
            ...tool,
            serverId: server.id,
            serverKey: server.key,
            namespacedName: buildNamespacedName(server.key, tool.name),
          });
        }
      } catch (err) {
        log.warn(
          {
            serverKey: server.key,
            companyId,
            err: err instanceof Error ? err.message : String(err),
          },
          "failed to list tools for external mcp server (skipping)",
        );
      }
    }
    return out;
  }

  return {
    listToolsForCompany,
    listServers,
    buildNamespacedName,
    parseNamespacedName,
  };
}

export type CreateExternalMcpToolSource = ReturnType<typeof createExternalMcpToolSource>;
