import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { activityService, normalizeActivityLimit } from "../services/activity.js";
import { assertAuthenticated, assertBoard, assertCompanyAccess } from "./authz.js";
import {
  excludeOthersPersonalCompanies,
  viewerUserIdForPersonalCheck,
} from "../services/personal-companies.js";
import { companyService, heartbeatService, issueService } from "../services/index.js";
import { accessService } from "../services/access.js";
import { agentActionAuditService } from "../services/agent-action-audit.js";
import { logActivity } from "../services/activity-log.js";
import type { AuthorizationActor } from "../services/authorization.js";
import { sanitizeRecord } from "../redaction.js";
import { badRequest, forbidden } from "../errors.js";

/** Max rows a single CSV export will stream (guards against runaway exports). */
const AUDIT_CSV_EXPORT_MAX_ROWS = 10_000;
const AUDIT_CSV_PAGE_SIZE = 200;
const CSV_FORMULA_CHARS = /^[=+\-@\t\r]/;
// A spreadsheet set to split on ";", tabs or line breaks starts a new cell
// there, so a formula character after one is neutralised too.
const CSV_EMBEDDED_FORMULA_CHARS = /([;\t\r\n])([=+\-@])/g;

const AUDIT_CSV_COLUMNS = [
  "createdAt",
  "action",
  "actorType",
  "actorId",
  "agentId",
  "runId",
  "responsibleUserId",
  "entityType",
  "entityId",
  "issueIdentifier",
  "issueTitle",
  "commentExcerpt",
  "documentKey",
] as const;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = value instanceof Date ? value.toISOString() : String(value);
  // Prevent spreadsheet applications from interpreting user-controlled cells
  // as formulas when an operator opens the export.
  const safe = (CSV_FORMULA_CHARS.test(str) ? `'${str}` : str).replace(CSV_EMBEDDED_FORMULA_CHARS, "$1'$2");
  // Quote if the value contains a delimiter (",", or ";" where that is the
  // list separator), a quote, or a newline; escape quotes by doubling.
  return /[",;\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function readNested(value: unknown, ...keys: string[]): string | null {
  let cursor: unknown = value;
  for (const key of keys) {
    if (!cursor || typeof cursor !== "object") return null;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === "string" ? cursor : null;
}

type AuditCsvRow = {
  createdAt: Date | string;
  action: string;
  actorType: string | null;
  actorId: string | null;
  agentId: string | null;
  runId: string | null;
  responsibleUserId: string | null;
  entityType: string;
  entityId: string;
  // Enrichment snippet is redacted server-side into a plain record, so read it
  // defensively rather than assuming a fixed shape.
  entity: unknown;
};

function auditRowsToCsv(rows: AuditCsvRow[]): string {
  const lines = [AUDIT_CSV_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push([
      csvCell(row.createdAt),
      csvCell(row.action),
      csvCell(row.actorType),
      csvCell(row.actorId),
      csvCell(row.agentId),
      csvCell(row.runId),
      csvCell(row.responsibleUserId),
      csvCell(row.entityType),
      csvCell(row.entityId),
      csvCell(readNested(row.entity, "issue", "identifier")),
      csvCell(readNested(row.entity, "issue", "title")),
      csvCell(readNested(row.entity, "comment", "excerpt")),
      csvCell(readNested(row.entity, "document", "key")),
    ].join(","));
  }
  // Trailing newline keeps POSIX tools + spreadsheet importers happy.
  return `${lines.join("\r\n")}\r\n`;
}

const createActivitySchema = z.object({
  actorType: z.enum(["agent", "user", "system", "plugin"]).optional().default("system"),
  actorId: z.string().min(1),
  action: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  agentId: z.string().uuid().optional().nullable(),
  details: z.record(z.unknown()).optional().nullable(),
});

const agentActionAuditActorScopeSchema = z.enum(["agents", "all"]);

// Postgres refuses a NUL character in text and a timestamp outside years 1 to
// 9999, so those are a bad request here rather than a server error.
const auditTextFilterSchema = z.string().min(1).refine((value) => !value.includes("\u0000"), {
  message: "Must not contain a NUL character",
});
const auditDateFilterSchema = z.coerce.date().refine((value) => {
  const year = value.getUTCFullYear();
  return year >= 1 && year <= 9999;
}, { message: "Year must be 1 to 9999" });

const agentActionAuditQuerySchema = z.object({
  actorScope: agentActionAuditActorScopeSchema.default("agents"),
  agentId: z.string().uuid().optional(),
  responsibleUserId: auditTextFilterSchema.optional(),
  runId: z.string().uuid().optional(),
  entityType: auditTextFilterSchema.optional(),
  entityId: auditTextFilterSchema.optional(),
  action: auditTextFilterSchema.optional(),
  actorType: z.enum(["agent", "user", "system", "plugin"]).optional(),
  from: auditDateFilterSchema.optional(),
  to: auditDateFilterSchema.optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function activityRoutes(db: Db) {
  const router = Router();
  const svc = activityService(db);
  const heartbeat = heartbeatService(db);
  const issueSvc = issueService(db);
  const access = accessService(db);
  const agentAudit = agentActionAuditService(db);

  // "View agent audit actions" (audit:view_agent_actions) from Company Access,
  // decided by the shared authorization rules. Only people hold it here, as
  // upstream: an agent is always refused.
  async function hasAgentAuditPermission(req: Request, companyId: string) {
    if (req.actor.type !== "board") return false;
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
    const decision = await access.decide({
      actor: req.actor as AuthorizationActor,
      action: "audit:view_agent_actions",
      resource: { type: "company", companyId },
    });
    return decision.allowed;
  }

  async function assertAgentAuditPermission(req: Request, companyId: string) {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    if (await hasAgentAuditPermission(req, companyId)) return;
    throw forbidden("Missing permission: audit:view_agent_actions");
  }

  function hasAttributionFilters(query: z.infer<typeof agentActionAuditQuerySchema>) {
    return query.agentId !== undefined
      || query.responsibleUserId !== undefined
      || query.runId !== undefined
      || query.entityType !== undefined
      || query.entityId !== undefined
      || query.action !== undefined
      || query.actorType !== undefined
      || query.from !== undefined
      || query.to !== undefined;
  }

  function stripAuditAttribution<T extends {
    items: Array<{
      agentId: string | null;
      runId: string | null;
      responsibleUserId: string | null;
      details: unknown;
    }>;
  }>(result: T): T {
    return {
      ...result,
      items: result.items.map((item) => ({
        ...item,
        agentId: null,
        runId: null,
        responsibleUserId: null,
        details: null,
      })),
    };
  }

  async function assertCompanyScopeReadAllowed(req: Request, res: Response, companyId: string) {
    const decision = await access.decide({
      actor: req.actor as AuthorizationActor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (decision.allowed) return true;
    res.status(403).json({ error: "Activity is outside this actor's authorization boundary" });
    return false;
  }

  async function resolveIssueByRef(rawId: string) {
    if (/^[A-Z]+-\d+$/i.test(rawId)) {
      return issueSvc.getByIdentifier(rawId);
    }
    return issueSvc.getById(rawId);
  }

  router.get("/companies/:companyId/activity", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId, "read");

    const filters = {
      companyId,
      agentId: req.query.agentId as string | undefined,
      entityType: req.query.entityType as string | undefined,
      entityId: req.query.entityId as string | undefined,
      limit: normalizeActivityLimit(Number(req.query.limit)),
    };
    const result = await svc.list(filters);
    res.json(result);
  });

  router.get("/companies/:companyId/audit/agent-actions", async (req, res) => {
    const companyId = req.params.companyId as string;
    const parsedActorScope = agentActionAuditActorScopeSchema.safeParse(req.query.actorScope ?? "agents");
    if (!parsedActorScope.success) {
      throw badRequest("Invalid agent action audit query", parsedActorScope.error.issues);
    }
    if (parsedActorScope.data === "agents") {
      // Keep the legacy authorization-before-validation behavior for callers
      // that omit the new flag.
      await assertAgentAuditPermission(req, companyId);
    } else {
      assertCompanyAccess(req, companyId);
      if (!(await assertCompanyScopeReadAllowed(req, res, companyId))) return;
    }

    const parsedQuery = agentActionAuditQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      throw badRequest("Invalid agent action audit query", parsedQuery.error.issues);
    }
    if (parsedQuery.data.actorScope === "agents") {
      const result = await agentAudit.list({ companyId, ...parsedQuery.data });
      res.json({ ...result, accessTier: "full" });
      return;
    }

    const canViewAttribution = await hasAgentAuditPermission(req, companyId);
    if (!canViewAttribution && hasAttributionFilters(parsedQuery.data)) {
      throw forbidden("Audit filters require permission: audit:view_agent_actions");
    }
    const result = await agentAudit.list({ companyId, ...parsedQuery.data });
    res.json({
      ...(canViewAttribution ? result : stripAuditAttribution(result)),
      accessTier: canViewAttribution ? "full" : "basic",
    });
  });

  router.get("/companies/:companyId/audit/agent-actions.csv", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertAgentAuditPermission(req, companyId);
    const parsedQuery = agentActionAuditQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      throw badRequest("Invalid agent action audit query", parsedQuery.error.issues);
    }
    // Drive our own pagination for the export; a client-supplied cursor/limit
    // would silently truncate the export, so ignore them.
    const { cursor: _cursor, limit: _limit, ...filters } = parsedQuery.data;
    const rows: Awaited<ReturnType<typeof agentAudit.list>>["items"] = [];
    let cursor: string | undefined;
    do {
      // The file has no details column, so details are not read at all.
      const page = await agentAudit.list(
        { companyId, ...filters, cursor, limit: AUDIT_CSV_PAGE_SIZE },
        { includeDetails: false },
      );
      for (const item of page.items) {
        if (rows.length >= AUDIT_CSV_EXPORT_MAX_ROWS) break;
        rows.push(item);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor && rows.length < AUDIT_CSV_EXPORT_MAX_ROWS);
    const truncated = rows.length >= AUDIT_CSV_EXPORT_MAX_ROWS && Boolean(cursor);

    // The export is itself an auditable act: record who exported what filter
    // set and how many rows left the system.
    const actorUserId = req.actor.type === "board" ? req.actor.userId ?? null : null;
    await logActivity(db, {
      companyId,
      actorType: actorUserId ? "user" : "system",
      actorId: actorUserId ?? "local-board",
      action: "audit.exported",
      entityType: "company",
      entityId: companyId,
      details: {
        format: "csv",
        rowCount: rows.length,
        truncated,
        filters: {
          actorScope: filters.actorScope,
          agentId: filters.agentId ?? null,
          responsibleUserId: filters.responsibleUserId ?? null,
          runId: filters.runId ?? null,
          entityType: filters.entityType ?? null,
          entityId: filters.entityId ?? null,
          action: filters.action ?? null,
          actorType: filters.actorType ?? null,
          from: filters.from ? filters.from.toISOString() : null,
          to: filters.to ? filters.to.toISOString() : null,
        },
      },
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="agent-audit-${companyId}.csv"`);
    // Lets the screen say the file stops at the newest AUDIT_CSV_EXPORT_MAX_ROWS rows.
    res.setHeader("X-Paperclip-Export-Truncated", truncated ? "true" : "false");
    res.setHeader("X-Paperclip-Export-Row-Count", String(rows.length));
    // The byte-order mark makes Excel on Windows read the file as UTF-8, not
    // the local code page, so non-English text and the "…" in excerpts survive.
    res.send(`\uFEFF${auditRowsToCsv(rows)}`);
  });

  router.get("/companies/:companyId/portfolio-activity", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId, "read");

    const companySvc = companyService(db);
    const hqCompany = await companySvc.getById(companyId);
    if (!hqCompany?.isPortfolioRoot) {
      res.status(403).json({ error: "This endpoint is only available on the portfolio root company" });
      return;
    }

    const isPortfolioRootAccess =
      req.actor.type === "agent"
        ? req.actor.isPortfolioRootAgent
        : req.actor.type === "board" && (
            req.actor.source === "local_implicit" ||
            req.actor.isInstanceAdmin ||
            req.actor.isPortfolioRootUserAdmin
          );
    if (!isPortfolioRootAccess) {
      res.status(403).json({ error: "Portfolio root access required" });
      return;
    }

    const companyIdsFilter = req.query.companyIds as string | undefined;
    const perCompanyLimit = normalizeActivityLimit(Number(req.query.limit ?? 50));

    const allCompanies = await companySvc.list();
    // A roll-up across "everything" must still stop at people's private
    // companies. Without this, HQ's activity feed would show what every user
    // did in their Personal.
    let targetCompanies = excludeOthersPersonalCompanies(
      allCompanies,
      viewerUserIdForPersonalCheck(req.actor),
    ).filter((c) => c.status !== "archived");
    if (companyIdsFilter) {
      const allowed = new Set(companyIdsFilter.split(",").map((id) => id.trim()).filter(Boolean));
      targetCompanies = targetCompanies.filter((c) => allowed.has(c.id));
    }

    const eventArrays = await Promise.all(
      targetCompanies.map((company) =>
        svc.list({ companyId: company.id, limit: perCompanyLimit }),
      ),
    );

    const allEvents = eventArrays
      .flat()
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 200);

    res.json({ events: allEvents, companies: targetCompanies });
  });

  router.post("/companies/:companyId/activity", validate(createActivitySchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const event = await svc.create({
      companyId,
      ...req.body,
      details: req.body.details ? sanitizeRecord(req.body.details) : null,
    });
    res.status(201).json(event);
  });

  router.get("/issues/:id/activity", async (req, res) => {
    const rawId = req.params.id as string;
    const issue = await resolveIssueByRef(rawId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const result = await svc.forIssue(issue.id);
    res.json(result);
  });

  router.get("/issues/:id/runs", async (req, res) => {
    const rawId = req.params.id as string;
    const issue = await resolveIssueByRef(rawId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const result = await svc.runsForIssue(issue.companyId, issue.id);
    res.json(result);
  });

  router.get("/heartbeat-runs/:runId/issues", async (req, res) => {
    assertAuthenticated(req);
    const runId = req.params.runId as string;
    const run = await heartbeat.getRun(runId);
    if (!run) {
      res.json([]);
      return;
    }
    assertCompanyAccess(req, run.companyId);
    const result = await svc.issuesForRun(runId);
    res.json(result);
  });

  return router;
}
