import { Router } from "express";
import type { Db } from "@paperclipai/db";
import type { AttentionRow } from "@paperclipai/shared";
import { attentionQueueService, sortAttentionRows } from "../services/attention-queue.js";
import { accessService } from "../services/access.js";
import { companyService } from "../services/companies.js";
import { inboxDismissalService } from "../services/inbox-dismissals.js";
import { assertCompanyAccess } from "./authz.js";
import {
  excludeOthersPersonalCompanies,
  viewerUserIdForPersonalCheck,
} from "../services/personal-companies.js";

/**
 * The attention queue endpoints. One list of open decisions per company,
 * plus the portfolio roll-up. Every surface that asks the operator to act
 * reads these; nothing computes its own "needs you" list.
 */
export function attentionRoutes(db: Db) {
  const router = Router();
  const queue = attentionQueueService(db);
  const access = accessService(db);
  const companies = companyService(db);
  const dismissals = inboxDismissalService(db);

  async function resolveActor(req: Parameters<typeof assertCompanyAccess>[0], companyId: string) {
    // Join requests only belong in the queue for someone who can decide
    // them; mirrors the sidebar-badges route's gate.
    let canApproveJoins = false;
    if (req.actor.type === "board") {
      canApproveJoins =
        req.actor.source === "local_implicit" ||
        Boolean(req.actor.isInstanceAdmin) ||
        (await access.canUser(companyId, req.actor.userId, "joins:approve"));
    } else if (req.actor.type === "agent" && req.actor.agentId) {
      canApproveJoins = await access.hasPermission(
        companyId,
        "agent",
        req.actor.agentId,
        "joins:approve",
      );
    }
    // Hiding is per person, so only a signed-in board user has any.
    const userId = req.actor.type === "board" ? req.actor.userId ?? null : null;
    const hidden = userId ? await dismissals.loadHiddenByKey(companyId, userId) : null;

    return {
      userId,
      canApproveJoins,
      dismissedAtByKey: hidden?.dismissedAtByKey,
      snoozedUntilByKey: hidden?.snoozedUntilByKey,
    };
  }

  router.get("/companies/:companyId/attention", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId, "read");
    // `setAside=1` asks for the rows that have gone quiet as well, so a surface
    // can show what it is normally holding back rather than only counting it.
    const includeSetAside = req.query.setAside === "1";
    const result = await queue.listForCompany(
      companyId,
      await resolveActor(req, companyId),
      { includeSetAside },
    );
    res.json({ rows: result.rows, count: result.rows.length, setAside: result.setAside });
  });

  // Portfolio roll-up, HQ only. Guard mirrors the sibling portfolio feeds.
  router.get("/companies/:companyId/portfolio-attention", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId, "read");

    const hqCompany = await companies.getById(companyId);
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

    const includeSetAside = req.query.setAside === "1";
    const allCompanies = excludeOthersPersonalCompanies(
      await companies.list(),
      viewerUserIdForPersonalCheck(req.actor),
    );
    const targets = allCompanies.filter((company) => company.status !== "archived");
    const perCompany = await Promise.all(
      targets.map(async (company) => {
        const result = await queue.listForCompany(
          company.id,
          await resolveActor(req, company.id),
          { includeSetAside },
        );
        // Stamp company identity so portfolio rows can be grouped and linked
        // without a second lookup on the client.
        return {
          setAside: result.setAside,
          rows: result.rows.map((row): AttentionRow => ({
            ...row,
            companyName: company.name,
            companyIssuePrefix: company.issuePrefix ?? null,
          })),
        };
      }),
    );

    const rows = sortAttentionRows(perCompany.flatMap((entry) => entry.rows));
    const setAside = perCompany.reduce((total, entry) => total + entry.setAside, 0);
    res.json({ rows, count: rows.length, setAside, companies: targets });
  });

  return router;
}
