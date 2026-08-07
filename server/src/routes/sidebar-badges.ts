import { Router } from "express";
import type { Db } from "@paperclipai/db";
import type { AttentionRow, SidebarBadges } from "@paperclipai/shared";
import { attentionQueueService } from "../services/attention-queue.js";
import { accessService } from "../services/access.js";
import { inboxDismissalService } from "../services/inbox-dismissals.js";
import { assertCompanyAccess } from "./authz.js";

/**
 * The sidebar and company-rail counts. These are a projection of the
 * attention queue, not a second opinion about it: the number on the Inbox
 * is exactly how many rows the Inbox will show.
 *
 * It used to be its own formula, and it disagreed with everything else.
 * It counted each agent's newest failed run (so twenty broken issues read as
 * one, and any later success anywhere read as zero), added two company-health
 * alerts that were not decisions and had nothing to click, and knew nothing
 * about agents' questions or work waiting on a sign-off - the two most
 * urgent things in the product.
 */
export function sidebarBadgeRoutes(db: Db) {
  const router = Router();
  const queue = attentionQueueService(db);
  const access = accessService(db);
  const dismissals = inboxDismissalService(db);

  router.get("/companies/:companyId/sidebar-badges", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    let canApproveJoins = false;
    if (req.actor.type === "board") {
      canApproveJoins =
        req.actor.source === "local_implicit" ||
        Boolean(req.actor.isInstanceAdmin) ||
        (await access.canUser(companyId, req.actor.userId, "joins:approve"));
    } else if (req.actor.type === "agent" && req.actor.agentId) {
      canApproveJoins = await access.hasPermission(companyId, "agent", req.actor.agentId, "joins:approve");
    }

    const userId = req.actor.type === "board" ? req.actor.userId ?? null : null;
    const hidden = userId ? await dismissals.loadHiddenByKey(companyId, userId) : null;

    // Badges count only live rows. A failure that has gone quiet must not keep
    // a number on the sidebar for months.
    const { rows } = await queue.listForCompany(companyId, {
      userId,
      canApproveJoins,
      dismissedAtByKey: hidden?.dismissedAtByKey,
      snoozedUntilByKey: hidden?.snoozedUntilByKey,
    });
    res.json(summarizeAttentionForBadges(rows));
  });

  return router;
}

/**
 * One row is one thing to deal with, so the headline number is the row
 * count. Rows carry their own `count` for repeats ("failed 5 times"), which
 * is detail for the row to show, not extra units of work for the badge.
 */
export function summarizeAttentionForBadges(rows: readonly AttentionRow[]): SidebarBadges {
  return {
    inbox: rows.length,
    approvals: rows.filter((row) => row.kind === "approval").length,
    failedRuns: rows.filter((row) => row.kind === "run_failure").length,
    joinRequests: rows.filter((row) => row.kind === "join_request").length,
  };
}
