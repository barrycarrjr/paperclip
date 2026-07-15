/**
 * Internal notification endpoints backing the desktop tray. The tray polls
 * `pending` for reminder deliveries fired with the `desktop` channel (left in
 * `pending` for the local client to surface) and calls `ack` once it has shown
 * them, flipping those rows to `delivered`.
 *
 * These are not company-scoped: the desktop tray is the local user's own queue.
 *
 * Auth: the tray is a local process that polls over loopback with NO auth token.
 * In `authenticated` deployment mode that request arrives as an unauthenticated
 * actor (`type: "none"`), so we treat an UNAUTHENTICATED LOOPBACK request as the
 * local user, since only a process on this machine can reach loopback. A loopback
 * request that DID present a token keeps its real identity, so an agent key is
 * still refused and cannot drain the tray. Non-loopback callers must be a
 * user-driven (board / tool-session) actor. In `local_trusted` mode every request
 * is already an implicit board actor, so this simply passes through.
 */
import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { calendarService } from "../services/index.js";
import { assertAuthenticated, isUserDrivenActor } from "./authz.js";
import { forbidden } from "../errors.js";

/** True when the TCP peer is the loopback interface (a process on this host). */
function isLoopbackRequest(req: Request): boolean {
  const addr = req.socket.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function assertLocalTrayAccess(req: Request) {
  // A tokenless loopback request is the local desktop tray (which has no way to
  // present a login). Allow it. This is the only way desktop popups work in
  // `authenticated` mode, where an unauthenticated request is actor.type "none".
  if (req.actor.type === "none" && isLoopbackRequest(req)) return;
  // Otherwise require a real user-driven actor: this refuses agent keys (so an
  // agent can't drain the tray) and rejects external unauthenticated callers.
  assertAuthenticated(req);
  if (!isUserDrivenActor(req)) {
    throw forbidden("Desktop notifications are only available to the local user");
  }
}

export function internalNotificationRoutes(db: Db) {
  const router = Router();
  const svc = calendarService(db);

  router.get("/internal/desktop-notifications/pending", async (req, res) => {
    assertLocalTrayAccess(req);
    const limit = Number(req.query.limit) || 20;
    res.json({ notifications: await svc.listPendingDesktopNotifications(limit) });
  });

  router.post("/internal/desktop-notifications/ack", async (req, res) => {
    assertLocalTrayAccess(req);
    const rawIds = (req.body as { ids?: unknown } | undefined)?.ids;
    const ids = Array.isArray(rawIds) ? rawIds.filter((id): id is string => typeof id === "string") : [];
    res.json({ acknowledged: await svc.ackDesktopNotifications(ids) });
  });

  return router;
}
