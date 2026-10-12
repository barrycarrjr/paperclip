import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import { accountApprovalService } from "../services/account-approvals.js";
import { assertInstanceAdmin } from "./authz.js";

/**
 * New accounts waiting for an instance admin, and the admin's answer to each.
 * See services/account-approvals.ts for what waiting means.
 *
 * Instance admins only, and an account still waiting can never be one: the
 * actor middleware gives a waiting account no admin role, whatever it holds.
 *
 * No activity rows: those belong to a company, and an account is not any one
 * company's business. The account row keeps who decided and when.
 */
export function accountRequestRoutes(db: Db) {
  const router = Router();
  const approvals = accountApprovalService(db);

  router.get("/admin/account-requests", async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await approvals.listWaiting());
  });

  router.post("/admin/account-requests/:userId/approve", async (req, res) => {
    assertInstanceAdmin(req);
    const userId = req.params.userId as string;
    const status = await approvals.approve(userId, req.actor.userId ?? null);
    if (!status) throw notFound("Account not found");
    // A second click, or a second admin, finds it approved already: done.
    if (status === "declined") throw conflict("This account was declined. It cannot be approved.");
    res.json({ id: userId, status });
  });

  router.post("/admin/account-requests/:userId/decline", async (req, res) => {
    assertInstanceAdmin(req);
    const userId = req.params.userId as string;
    const status = await approvals.decline(userId, req.actor.userId ?? null);
    if (!status) throw notFound("Account not found");
    if (status === "approved") throw conflict("This account is already approved. It cannot be declined.");
    res.json({ id: userId, status });
  });

  return router;
}
