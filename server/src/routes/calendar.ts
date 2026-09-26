import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { createEventSchema, updateEventSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { accessService, calendarService, companyService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo, isUserDrivenActor } from "./authz.js";
import {
  excludeOthersPersonalCompanies,
  viewerUserIdForPersonalCheck,
} from "../services/personal-companies.js";
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
  const access = accessService(db);

  /**
   * The person an agent's reminders belong to, or null when the agent may not
   * create reminders in this company. An agent needs the
   * `reminders:create_for_board` grant, which only a person can give (see the
   * agent permissions route), and the reminder is owned by that person. A grant
   * with no person recorded behind it is treated as no grant.
   */
  async function reminderOwnerForAgent(req: Request, companyId: string): Promise<string | null> {
    if (req.actor.type !== "agent" || !req.actor.agentId) return null;
    const allowed = await access.hasPermission(
      companyId,
      "agent",
      req.actor.agentId,
      "reminders:create_for_board",
    );
    if (!allowed) return null;
    const grants = await access.listPrincipalGrants(companyId, "agent", req.actor.agentId);
    const grant = grants.find((g) => g.permissionKey === "reminders:create_for_board");
    return grant?.grantedByUserId ?? null;
  }

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
    // An agent may change or remove reminders it created itself, for as long
    // as it still holds the grant (so moving a deadline after an extension
    // does not need a person), but never anyone else's.
    if (req.actor.type === "agent") {
      const ownsIt = Boolean(req.actor.agentId) && ev.createdByAgentId === req.actor.agentId;
      if (ownsIt && (await reminderOwnerForAgent(req, ev.companyId)) !== null) {
        return ev;
      }
      throw forbidden("You can only modify reminders you created");
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

    const allCompanies = excludeOthersPersonalCompanies(
      await companySvc.list(),
      viewerUserIdForPersonalCheck(req.actor),
    );
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

    const allCompanies = excludeOthersPersonalCompanies(
      await companySvc.list(),
      viewerUserIdForPersonalCheck(req.actor),
    );
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
    let userId: string;
    let agentId: string | null = null;
    if (isUserDrivenActor(req)) {
      userId = req.actor.userId ?? "board";
    } else {
      const owner = await reminderOwnerForAgent(req, companyId);
      if (owner === null) {
        throw forbidden("Reminders can only be created by a user");
      }
      userId = owner;
      agentId = req.actor.agentId ?? null;
    }
    const created = await svc.create(companyId, req.body, { userId, agentId });
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
