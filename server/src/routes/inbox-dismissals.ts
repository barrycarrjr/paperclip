import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { inboxDismissalService, logActivity } from "../services/index.js";

/**
 * Every kind the attention queue produces, plus `issue:` from the Inbox's own
 * rows. The list used to stop at approval/join/run/issue, which quietly made
 * questions, sign-off gates and budget stops impossible to hide: the request
 * was rejected with a 400 the UI never surfaced.
 */
const ITEM_KEY_RE = /^(approval|join|run|run-group|issue|question|sign_off|budget|email):.+$/;

const inboxDismissalSchema = z.object({
  itemKey: z.string().trim().min(1).regex(ITEM_KEY_RE, "Unsupported inbox item key"),
});

const inboxSnoozeSchema = z.object({
  itemKey: z.string().trim().min(1).regex(ITEM_KEY_RE, "Unsupported inbox item key"),
  /** ISO timestamp in the future, or null to bring it back now. */
  snoozedUntil: z.string().datetime().nullable(),
});

export function inboxDismissalRoutes(db: Db) {
  const router = Router();
  const svc = inboxDismissalService(db);

  router.get("/companies/:companyId/inbox-dismissals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const dismissals = await svc.list(companyId, req.actor.userId);
    res.json(dismissals);
  });

  router.post(
    "/companies/:companyId/inbox-dismissals",
    validate(inboxDismissalSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      if (req.actor.type !== "board") {
        res.status(403).json({ error: "Board authentication required" });
        return;
      }
      if (!req.actor.userId) {
        res.status(403).json({ error: "Board user context required" });
        return;
      }

      const dismissal = await svc.dismiss(companyId, req.actor.userId, req.body.itemKey, new Date());
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "inbox.dismissed",
        entityType: "company",
        entityId: companyId,
        details: {
          userId: req.actor.userId,
          itemKey: dismissal.itemKey,
          dismissedAt: dismissal.dismissedAt,
        },
      });

      res.status(201).json(dismissal);
    },
  );

  router.post(
    "/companies/:companyId/inbox-snoozes",
    validate(inboxSnoozeSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      if (req.actor.type !== "board") {
        res.status(403).json({ error: "Board authentication required" });
        return;
      }
      if (!req.actor.userId) {
        res.status(403).json({ error: "Board user context required" });
        return;
      }

      const raw = req.body.snoozedUntil as string | null;
      let snoozedUntil: Date | null = null;
      if (raw !== null) {
        const parsed = new Date(raw);
        if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
          res.status(400).json({ error: "snoozedUntil must be a future ISO datetime" });
          return;
        }
        snoozedUntil = parsed;
      }

      const row = await svc.snooze(companyId, req.actor.userId, req.body.itemKey, snoozedUntil);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: snoozedUntil ? "inbox.snoozed" : "inbox.unsnoozed",
        entityType: "company",
        entityId: companyId,
        details: {
          userId: req.actor.userId,
          itemKey: row.itemKey,
          snoozedUntil: row.snoozedUntil,
        },
      });

      res.status(201).json(row);
    },
  );

  return router;
}
