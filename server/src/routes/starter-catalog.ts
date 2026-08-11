import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { searchStarterCards, STARTER_CATEGORIES } from "@paperclipai/shared";
import { starterCatalogService } from "../services/starter-catalog.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * Routes for the starter catalog — what sits behind "What do you want done?".
 *
 * `GET  /companies/:companyId/starter-catalog`            browse, with readiness
 * `GET  /companies/:companyId/starter-catalog/search?q=`  free-text box
 * `POST /companies/:companyId/starter-catalog/:cardId/activate`  switch one on
 */
export function starterCatalogRoutes(
  db: Db,
  deps: { enablePlugin?: (pluginId: string) => Promise<unknown> } = {},
) {
  const router = Router();
  const svc = starterCatalogService(db, { enablePlugin: deps.enablePlugin });

  router.get("/companies/:companyId/starter-catalog", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId, "read");
    const cards = await svc.listForCompany(companyId);
    res.json({ categories: STARTER_CATEGORIES, cards });
  });

  /**
   * Free-text lookup. Always answers — an empty `matches` list is the signal
   * that nothing in the catalog fits, which the UI turns into "hand it to the
   * CEO as a plain request" rather than a dead end. Nobody should be stuck
   * because they used a word the catalog doesn't know.
   */
  router.get("/companies/:companyId/starter-catalog/search", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId, "read");
    const query = typeof req.query.q === "string" ? req.query.q : "";
    const matchIds = new Set(searchStarterCards(query).map((c) => c.id));
    const all = await svc.listForCompany(companyId);
    res.json({
      query,
      matches: all.filter((entry) => matchIds.has(entry.card.id)),
    });
  });

  router.post("/companies/:companyId/starter-catalog/:cardId/activate", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId, "write");
    const actor = getActorInfo(req);
    const result = await svc.activate(companyId, req.params.cardId as string, {
      // Agent actors have no users.id to attribute to; the routine's
      // createdBy stays null rather than pointing at a non-existent key.
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    res.status(201).json(result);
  });

  return router;
}
