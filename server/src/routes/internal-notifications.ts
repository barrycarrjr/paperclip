/**
 * Internal notification endpoints backing the desktop tray. The tray polls
 * `pending` for reminder deliveries that were fired with the `desktop` channel
 * (left in `pending` for the local client to surface) and calls `ack` once it
 * has shown them, flipping those rows to `delivered`.
 *
 * These are not company-scoped: the desktop tray is the local user's own queue.
 * We still refuse non-user actors (agents) so an agent key can't drain the
 * tray — only a board / tool-session (user-driven) actor may read or ack.
 */
import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { calendarService } from "../services/index.js";
import { assertAuthenticated, isUserDrivenActor } from "./authz.js";
import { forbidden } from "../errors.js";

function assertLocalUser(req: Request) {
  assertAuthenticated(req);
  if (!isUserDrivenActor(req)) {
    throw forbidden("Desktop notifications are only available to the local user");
  }
}

export function internalNotificationRoutes(db: Db) {
  const router = Router();
  const svc = calendarService(db);

  router.get("/internal/desktop-notifications/pending", async (req, res) => {
    assertLocalUser(req);
    const limit = Number(req.query.limit) || 20;
    res.json({ notifications: await svc.listPendingDesktopNotifications(limit) });
  });

  router.post("/internal/desktop-notifications/ack", async (req, res) => {
    assertLocalUser(req);
    const rawIds = (req.body as { ids?: unknown } | undefined)?.ids;
    const ids = Array.isArray(rawIds) ? rawIds.filter((id): id is string => typeof id === "string") : [];
    res.json({ acknowledged: await svc.ackDesktopNotifications(ids) });
  });

  return router;
}
