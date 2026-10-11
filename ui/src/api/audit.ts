import { api, ApiError } from "./client";

/**
 * Agent action audit API client, for
 * GET /companies/:companyId/audit/agent-actions (server/src/routes/activity.ts).
 * The default agent scope needs the `audit:view_agent_actions` permission.
 * The all-actors scope also answers ordinary company readers, at a basic tier
 * with attribution stripped, so its `accessTier` tells a client which one the
 * caller has. The CSV export needs the permission and logs itself.
 */

/** Render-ready entity snippets attached to each row at read time. */
export interface AuditEntitySnippet {
  issue: { id: string; identifier: string | null; title: string | null } | null;
  comment: { id: string; excerpt: string } | null;
  document: { id: string; key: string } | null;
}

/** One enriched `activity_log` row from the agent action audit feed. */
export interface AuditActionRecord {
  id: string;
  companyId: string;
  actorType: "agent" | "user" | "system" | "plugin" | null;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  agentId: string | null;
  runId: string | null;
  responsibleUserId: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
  entity: AuditEntitySnippet;
}

export interface AuditActionsResponse {
  items: AuditActionRecord[];
  nextCursor: string | null;
  /** "full" when the caller holds audit:view_agent_actions. */
  accessTier: "basic" | "full";
}

/** Server-side filters for the audit feed. All optional. */
export interface AuditActionFilters {
  /** Defaults to `agents`; `all` opts into the unified all-actors feed. */
  actorScope?: "agents" | "all";
  agentId?: string | null;
  responsibleUserId?: string | null;
  runId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  /** Action prefix, e.g. `issue.` or `issue.comment_added`. */
  action?: string | null;
  /** ISO-8601 with offset. */
  from?: string | null;
  to?: string | null;
  actorType?: "agent" | "user" | "system" | "plugin" | null;
  cursor?: string | null;
  limit?: number;
}

function buildAuditQuery(filters: AuditActionFilters): URLSearchParams {
  const search = new URLSearchParams();
  if (filters.actorScope) search.set("actorScope", filters.actorScope);
  if (filters.agentId) search.set("agentId", filters.agentId);
  if (filters.responsibleUserId) search.set("responsibleUserId", filters.responsibleUserId);
  if (filters.runId) search.set("runId", filters.runId);
  if (filters.entityType) search.set("entityType", filters.entityType);
  if (filters.entityId) search.set("entityId", filters.entityId);
  if (filters.action) search.set("action", filters.action);
  if (filters.from) search.set("from", filters.from);
  if (filters.to) search.set("to", filters.to);
  if (filters.actorType) search.set("actorType", filters.actorType);
  if (filters.cursor) search.set("cursor", filters.cursor);
  if (filters.limit != null) search.set("limit", String(filters.limit));
  return search;
}

export const auditApi = {
  /**
   * Cursor-paginated audit feed. The default agent scope answers 403 without
   * `audit:view_agent_actions`.
   */
  listAgentActions: (companyId: string, filters: AuditActionFilters = {}) => {
    const qs = buildAuditQuery(filters).toString();
    return api.get<AuditActionsResponse>(
      `/companies/${companyId}/audit/agent-actions${qs ? `?${qs}` : ""}`,
    );
  },

  /** The filtered feed as a CSV file. The server records the export. */
  exportAgentActionsCsv: async (
    companyId: string,
    filters: Omit<AuditActionFilters, "cursor" | "limit"> = {},
  ): Promise<Blob> => {
    const qs = buildAuditQuery(filters).toString();
    const res = await fetch(
      `/api/companies/${companyId}/audit/agent-actions.csv${qs ? `?${qs}` : ""}`,
      { credentials: "include", headers: { Accept: "text/csv" } },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const message = (body as { error?: string } | null)?.error ?? `Download failed: ${res.status}`;
      throw new ApiError(message, res.status, body);
    }
    return res.blob();
  },
};
