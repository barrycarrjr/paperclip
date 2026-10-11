import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { activityLog, heartbeatRuns, issueComments, issueDocuments, issues } from "@paperclipai/db";
import { createActivityDetailsRedactor } from "./activity-log.js";
import { badRequest } from "../errors.js";
import { redactSensitiveText } from "../redaction.js";
import { visibleIssueCondition } from "./issue-visibility.js";

export interface AgentActionAuditFilters {
  companyId: string;
  actorScope?: "agents" | "all";
  agentId?: string;
  responsibleUserId?: string;
  runId?: string;
  entityType?: string;
  entityId?: string;
  action?: string;
  actorType?: "agent" | "user" | "system" | "plugin";
  from?: Date;
  to?: Date;
  cursor?: string;
  limit: number;
}

export interface AgentActionAuditListOptions {
  /** False skips reading and redacting details, for callers that never show them (the CSV export). */
  includeDetails?: boolean;
}

type CursorValue = { createdAt: string; id: string };

const cursorValueSchema = z.object({
  // encodeCursor always writes UTC ("Z"). Postgres refuses year 0000 and
  // offsets such as +99:99, so a cursor made by hand must not carry them into
  // the query.
  createdAt: z.string().datetime().refine((value) => !value.startsWith("0000"), "Year must be 1 to 9999"),
  id: z.string().uuid(),
});

function decodeCursor(cursor: string | undefined): CursorValue | null {
  if (!cursor) return null;
  try {
    const parsed = cursorValueSchema.safeParse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function encodeCursor(value: CursorValue) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

// Entity ids in the log are plain text, and anyone on the board can log a
// row (POST /companies/:id/activity). Postgres refuses a malformed uuid in the
// lookups below, so one such row would fail the whole page. Those rows are
// listed without enrichment instead.
const UUID_TEXT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function entityIdsOfType(rows: Array<{ entityType: string; entityId: string }>, entityType: string) {
  return [...new Set(rows
    .filter((row) => row.entityType === entityType && UUID_TEXT_RE.test(row.entityId))
    .map((row) => row.entityId))];
}

function excerpt(value: string, maxLength = 280) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

export function agentActionAuditService(db: Db) {
  return {
    list: async (filters: AgentActionAuditFilters, options: AgentActionAuditListOptions = {}) => {
      const includeDetails = options.includeDetails !== false;
      const cursor = decodeCursor(filters.cursor);
      if (filters.cursor && !cursor) throw badRequest("Invalid audit cursor");
      const effectiveResponsibleUserId = sql<string | null>`coalesce(${activityLog.responsibleUserId}, ${heartbeatRuns.responsibleUserId})`;
      const conditions = [eq(activityLog.companyId, filters.companyId)];
      // Preserve the historical agent-audit query unless the caller opts into
      // the unified all-actors feed explicitly.
      if (filters.actorScope !== "all") conditions.push(isNotNull(activityLog.agentId));
      if (filters.agentId) conditions.push(eq(activityLog.agentId, filters.agentId));
      if (filters.responsibleUserId) conditions.push(or(
        eq(activityLog.responsibleUserId, filters.responsibleUserId),
        and(
          isNull(activityLog.responsibleUserId),
          eq(heartbeatRuns.responsibleUserId, filters.responsibleUserId),
        ),
      )!);
      if (filters.runId) conditions.push(eq(activityLog.runId, filters.runId));
      if (filters.entityType) conditions.push(eq(activityLog.entityType, filters.entityType));
      if (filters.entityId) conditions.push(eq(activityLog.entityId, filters.entityId));
      if (filters.action) conditions.push(sql<boolean>`starts_with(${activityLog.action}, ${filters.action})`);
      if (filters.actorType) conditions.push(eq(activityLog.actorType, filters.actorType));
      if (filters.from) conditions.push(gte(activityLog.createdAt, filters.from));
      if (filters.to) conditions.push(lte(activityLog.createdAt, filters.to));
      if (cursor) {
        conditions.push(or(
          sql<boolean>`${activityLog.createdAt} < ${cursor.createdAt}::timestamptz`,
          and(
            sql<boolean>`${activityLog.createdAt} = ${cursor.createdAt}::timestamptz`,
            lt(activityLog.id, cursor.id),
          ),
        )!);
      }

      const rows = await db.select({
        id: activityLog.id,
        companyId: activityLog.companyId,
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        action: activityLog.action,
        entityType: activityLog.entityType,
        entityId: activityLog.entityId,
        agentId: activityLog.agentId,
        runId: activityLog.runId,
        responsibleUserId: effectiveResponsibleUserId,
        // Details can be large, so a caller that never shows them does not read them.
        details: includeDetails ? activityLog.details : sql<Record<string, unknown> | null>`null`,
        createdAt: activityLog.createdAt,
        cursorCreatedAt: sql<string>`to_char(${activityLog.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as("cursor_created_at"),
      }).from(activityLog).leftJoin(heartbeatRuns, and(
        eq(heartbeatRuns.companyId, activityLog.companyId),
        eq(heartbeatRuns.id, activityLog.runId),
      )).where(and(...conditions)).orderBy(desc(activityLog.createdAt), desc(activityLog.id)).limit(filters.limit + 1);

      const page = rows.slice(0, filters.limit);
      const commentEntityIds = entityIdsOfType(page, "issue_comment");
      const issueEntityIds = entityIdsOfType(page, "issue");
      const documentEntityIds = entityIdsOfType(page, "issue_document");
      // Tasks are looked up whether hidden or not, so a hidden task can be told
      // apart from one that was deleted.
      const issueVisible = sql<boolean>`(${visibleIssueCondition()})`;
      const commentRows = commentEntityIds.length === 0 ? [] : await db.select({
        id: issueComments.id, body: issueComments.body, issueId: issues.id, identifier: issues.identifier, title: issues.title,
        issueVisible,
      }).from(issueComments).innerJoin(issues, and(
        eq(issues.id, issueComments.issueId),
        eq(issues.companyId, filters.companyId),
      )).where(and(
        eq(issueComments.companyId, filters.companyId),
        inArray(issueComments.id, commentEntityIds),
      ));
      const issueRows = issueEntityIds.length === 0 ? [] : await db.select({
        id: issues.id, identifier: issues.identifier, title: issues.title,
        issueVisible,
      }).from(issues).where(and(
        eq(issues.companyId, filters.companyId),
        inArray(issues.id, issueEntityIds),
      ));
      const documentRows = documentEntityIds.length === 0 ? [] : await db.select({
        id: issueDocuments.id, documentId: issueDocuments.documentId, key: issueDocuments.key,
        issueId: issues.id, identifier: issues.identifier, title: issues.title,
        issueVisible,
      }).from(issueDocuments).innerJoin(issues, and(
        eq(issues.id, issueDocuments.issueId),
        eq(issues.companyId, filters.companyId),
      )).where(and(
        eq(issueDocuments.companyId, filters.companyId),
        or(
          inArray(issueDocuments.id, documentEntityIds),
          inArray(issueDocuments.documentId, documentEntityIds),
        ),
      ));

      const comments = new Map(commentRows.map((row) => [row.id, row]));
      const issueMap = new Map(issueRows.map((row) => [row.id, row]));
      const documents = new Map<string, (typeof documentRows)[number]>();
      for (const row of documentRows) {
        documents.set(row.id, row);
        documents.set(row.documentId, row);
      }

      const redactDetails = includeDetails ? await createActivityDetailsRedactor(db) : null;
      const items = page.map((row) => {
        const comment = row.entityType === "issue_comment" ? comments.get(row.entityId) : undefined;
        const issue = row.entityType === "issue" ? issueMap.get(row.entityId) : undefined;
        const document = row.entityType === "issue_document" ? documents.get(row.entityId) : undefined;
        // A row about a task that is hidden from view says nothing about it. A
        // deleted task is no longer there to look up, and keeps its details,
        // so its trail survives the delete.
        const task = comment ?? document ?? issue;
        const taskHidden = Boolean(task && !task.issueVisible);
        const visibleComment = comment?.issueVisible ? comment : undefined;
        const visibleDocument = document?.issueVisible ? document : undefined;
        const issueSnippet = visibleComment
          ? { id: visibleComment.issueId, identifier: visibleComment.identifier, title: visibleComment.title }
          : visibleDocument
            ? { id: visibleDocument.issueId, identifier: visibleDocument.identifier, title: visibleDocument.title }
            : issue?.issueVisible ? { id: issue.id, identifier: issue.identifier, title: issue.title } : null;
        return {
          id: row.id,
          companyId: row.companyId,
          actorType: row.actorType,
          actorId: row.actorId,
          action: row.action,
          entityType: row.entityType,
          entityId: row.entityId,
          agentId: row.agentId,
          runId: row.runId,
          responsibleUserId: row.responsibleUserId,
          createdAt: row.createdAt,
          details: redactDetails && !taskHidden ? redactDetails(row.details) : null,
          entity: {
            issue: issueSnippet,
            // Redacted before shortening, so a token cut in half is still found.
            comment: visibleComment
              ? { id: visibleComment.id, excerpt: excerpt(redactSensitiveText(visibleComment.body)) }
              : null,
            document: visibleDocument ? { id: visibleDocument.documentId, key: visibleDocument.key } : null,
          },
        };
      });
      const last = page.at(-1);
      return {
        items,
        nextCursor: rows.length > filters.limit && last
          ? encodeCursor({ createdAt: last.cursorCreatedAt, id: last.id })
          : null,
      };
    },
  };
}
