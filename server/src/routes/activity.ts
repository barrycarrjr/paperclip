import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { activityService, normalizeActivityLimit } from "../services/activity.js";
import { assertAuthenticated, assertBoard, assertCompanyAccess } from "./authz.js";
import { companyService, heartbeatService, issueService } from "../services/index.js";
import { sanitizeRecord } from "../redaction.js";

const createActivitySchema = z.object({
  actorType: z.enum(["agent", "user", "system", "plugin"]).optional().default("system"),
  actorId: z.string().min(1),
  action: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  agentId: z.string().uuid().optional().nullable(),
  details: z.record(z.unknown()).optional().nullable(),
});

export function activityRoutes(db: Db) {
  const router = Router();
  const svc = activityService(db);
  const heartbeat = heartbeatService(db);
  const issueSvc = issueService(db);

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
    let targetCompanies = allCompanies.filter((c) => c.status !== "archived");
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
