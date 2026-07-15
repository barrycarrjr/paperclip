import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { createEventSchema, updateEventSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { calendarService, companyService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo, isUserDrivenActor } from "./authz.js";
import { forbidden } from "../errors.js";

function parseDateParam(raw: unknown, fallback: Date): Date {
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function parseCommaList(raw: unknown): string[] | undefined {
  if (typeof raw !== "string") return undefined;
  const items = raw.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function currentMonthRange(now = new Date()): { from: Date; to: Date } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999));
  return { from, to };
}

export function calendarRoutes(db: Db) {
  const router = Router();
  const svc = calendarService(db);
  const companySvc = companyService(db);

  /**
   * True when the requester may read across the whole portfolio from the
   * portfolio-root company. Mirrors the routines portfolio gate exactly.
   */
  function hasPortfolioRootAccess(req: Request): boolean {
    return Boolean(
      req.actor.type === "agent" || req.actor.type === "tool_session"
        ? req.actor.isPortfolioRootAgent
        : req.actor.type === "board" &&
            (req.actor.source === "local_implicit" ||
              req.actor.isInstanceAdmin ||
              req.actor.isPortfolioRootUserAdmin),
    );
  }

  /**
   * Load an event and enforce owner-only management. The local implicit board
   * (single-user local_trusted mode) owns the `board`-owned events it creates,
   * so it is always allowed. Returns `null` when the event does not exist so
   * the caller can answer 404.
   */
  async function assertCanManageExistingEvent(req: Request, id: string) {
    const ev = await svc.getById(id);
    if (!ev) return null;
    assertCompanyAccess(req, ev.companyId);
    if (req.actor.type === "board" && req.actor.source === "local_implicit") {
      return ev;
    }
    const actorUserId = isUserDrivenActor(req) ? req.actor.userId ?? null : null;
    if (actorUserId !== ev.userId) {
      throw forbidden("You can only modify your own reminders");
    }
    return ev;
  }

  router.get("/companies/:companyId/events", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId, "read");
    res.json({ events: await svc.list(companyId) });
  });

  router.get("/companies/:companyId/portfolio-events", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId, "read");

    const hqCompany = await companySvc.getById(companyId);
    if (!hqCompany?.isPortfolioRoot) {
      res.status(403).json({ error: "This endpoint is only available on the portfolio root company" });
      return;
    }
    if (!hasPortfolioRootAccess(req)) {
      res.status(403).json({ error: "Portfolio root access required" });
      return;
    }

    const companyIdsFilter = req.query.companyIds as string | undefined;
    const statusFilter = parseCommaList(req.query.status);
    const kindsFilter = parseCommaList(req.query.kinds);

    const allCompanies = await companySvc.list();
    let targetCompanies = allCompanies.filter((c) => c.status !== "archived");
    if (companyIdsFilter) {
      const allowed = new Set(companyIdsFilter.split(",").map((id) => id.trim()).filter(Boolean));
      targetCompanies = targetCompanies.filter((c) => allowed.has(c.id));
    }

    const eventArrays = await Promise.all(targetCompanies.map((company) => svc.list(company.id)));
    let allEvents = eventArrays.flat();
    if (statusFilter) {
      const statuses = new Set(statusFilter);
      allEvents = allEvents.filter((e) => statuses.has(e.status));
    }
    if (kindsFilter) {
      const kinds = new Set(kindsFilter);
      allEvents = allEvents.filter((e) => kinds.has(e.kind));
    }

    res.json({ events: allEvents, companies: targetCompanies });
  });

  router.get("/companies/:companyId/calendar", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId, "read");
    const { from: defaultFrom, to: defaultTo } = currentMonthRange();
    const from = parseDateParam(req.query.from, defaultFrom);
    const to = parseDateParam(req.query.to, defaultTo);
    const kinds = parseCommaList(req.query.kinds);
    res.json({ occurrences: await svc.listOccurrences(companyId, from, to, { kinds }) });
  });

  router.get("/companies/:companyId/portfolio-calendar", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId, "read");

    const hqCompany = await companySvc.getById(companyId);
    if (!hqCompany?.isPortfolioRoot) {
      res.status(403).json({ error: "This endpoint is only available on the portfolio root company" });
      return;
    }
    if (!hasPortfolioRootAccess(req)) {
      res.status(403).json({ error: "Portfolio root access required" });
      return;
    }

    const companyIdsFilter = req.query.companyIds as string | undefined;
    const kinds = parseCommaList(req.query.kinds);
    const { from: defaultFrom, to: defaultTo } = currentMonthRange();
    const from = parseDateParam(req.query.from, defaultFrom);
    const to = parseDateParam(req.query.to, defaultTo);

    const allCompanies = await companySvc.list();
    let targetCompanies = allCompanies.filter((c) => c.status !== "archived");
    if (companyIdsFilter) {
      const allowed = new Set(companyIdsFilter.split(",").map((id) => id.trim()).filter(Boolean));
      targetCompanies = targetCompanies.filter((c) => allowed.has(c.id));
    }

    const occurrenceArrays = await Promise.all(
      targetCompanies.map((company) => svc.listOccurrences(company.id, from, to, { kinds })),
    );
    const occurrences = occurrenceArrays
      .flat()
      .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

    res.json({ occurrences, companies: targetCompanies });
  });

  router.post("/companies/:companyId/events", validate(createEventSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!isUserDrivenActor(req)) {
      throw forbidden("Reminders can only be created by a user");
    }
    const userId = req.actor.userId ?? "board";
    const created = await svc.create(companyId, req.body, { userId, agentId: null });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "calendar_event.created",
      entityType: "calendar_event",
      entityId: created.id,
      details: { title: created.title, kind: created.kind, scheduleKind: created.scheduleKind },
    });
    res.status(201).json(created);
  });

  router.get("/events/:id", async (req, res) => {
    const detail = await svc.getDetail(req.params.id as string);
    if (!detail) {
      res.status(404).json({ error: "Calendar event not found" });
      return;
    }
    assertCompanyAccess(req, detail.companyId, "read");
    res.json(detail);
  });

  router.patch("/events/:id", validate(updateEventSchema), async (req, res) => {
    const ev = await assertCanManageExistingEvent(req, req.params.id as string);
    if (!ev) {
      res.status(404).json({ error: "Calendar event not found" });
      return;
    }
    const updated = await svc.update(ev.id, req.body, {
      userId: isUserDrivenActor(req) ? req.actor.userId ?? "board" : null,
      agentId: req.actor.type === "agent" ? req.actor.agentId ?? null : null,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: ev.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "calendar_event.updated",
      entityType: "calendar_event",
      entityId: ev.id,
      details: { title: updated?.title ?? ev.title },
    });
    res.json(updated);
  });

  router.delete("/events/:id", async (req, res) => {
    const ev = await assertCanManageExistingEvent(req, req.params.id as string);
    if (!ev) {
      res.status(404).json({ error: "Calendar event not found" });
      return;
    }
    await svc.remove(ev.id);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: ev.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "calendar_event.deleted",
      entityType: "calendar_event",
      entityId: ev.id,
      details: { title: ev.title },
    });
    res.status(204).end();
  });

  router.post("/events/:id/fire", async (req, res) => {
    const ev = await assertCanManageExistingEvent(req, req.params.id as string);
    if (!ev) {
      res.status(404).json({ error: "Calendar event not found" });
      return;
    }
    await svc.fireNow(ev.id);
    res.json({ ok: true });
  });

  return router;
}
