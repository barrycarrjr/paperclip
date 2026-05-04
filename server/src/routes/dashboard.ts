import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { dashboardService } from "../services/dashboard.js";
import { companyService } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";

export function dashboardRoutes(db: Db) {
  const router = Router();
  const svc = dashboardService(db);

  router.get("/companies/:companyId/dashboard", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId, "read");
    const summary = await svc.summary(companyId);
    res.json(summary);
  });

  router.get("/companies/:companyId/portfolio-dashboard", async (req, res) => {
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

    const allCompanies = await companySvc.list();
    const targetCompanies = allCompanies.filter((c) => c.status !== "archived");

    const summaries = await Promise.all(
      targetCompanies.map((company) => svc.summary(company.id)),
    );

    res.json({ summaries, companies: targetCompanies });
  });

  return router;
}
