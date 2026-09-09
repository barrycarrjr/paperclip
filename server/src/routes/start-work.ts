import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { startWorkPlanRequestSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { startWorkService } from "../services/start-work.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * Plain-language "Start work" (P5b).
 *
 * `POST /companies/:companyId/start-work/plan`  draft a reviewable plan
 *
 * The company is the path parameter and nothing else: the body schema has
 * no companyId, so a body cannot point the plan somewhere else. Access is
 * checked the way the interaction accept route checks it (write access to
 * this company, then a board user), because drafting writes a container
 * issue and a card that only a board user can later accept.
 *
 * 201 for a fresh plan, 200 when the requestKey already had one.
 */
export function startWorkRoutes(db: Db) {
  const router = Router();
  const svc = startWorkService(db);

  router.post(
    "/companies/:companyId/start-work/plan",
    validate(startWorkPlanRequestSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId, "write");
      assertBoard(req);
      const actor = getActorInfo(req);

      const { status, ...body } = await svc.plan(companyId, req.body, { userId: actor.actorId });
      res.status(status === "existing" ? 200 : 201).json(body);
    },
  );

  return router;
}
