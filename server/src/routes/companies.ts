import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  companyPortabilityExportSchema,
  companyPortabilityImportSchema,
  companyPortabilityPreviewSchema,
  createCompanySchema,
  patchCompanyActionPolicySchema,
  patchCompanyAgentDefaultsSchema,
  updateCompanyBrandingSchema,
  updateCompanySchema,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import {
  PERSONAL_COMPANY_KIND,
  excludeOthersPersonalCompanies,
  viewerUserIdForPersonalCheck,
} from "../services/personal-companies.js";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  agentService,
  budgetService,
  companyAgentDefaultsService,
  companyPortabilityService,
  companyService,
  logActivity,
} from "../services/index.js";
import { agentInstructionsBundleMode } from "../services/agent-instructions.js";
import { resolvePortableExportAgentSelection } from "../services/company-portability-agent-selection.js";
import { agentActionPolicyService } from "../services/agent-action-policy.js";
import type { StorageService } from "../storage/types.js";
import {
  assertAuthenticated,
  assertBoard,
  assertCompanyAccess,
  assertInstanceAdmin,
  getActorInfo,
  hasInstanceAdminAccess,
} from "./authz.js";

export function companyRoutes(db: Db, storage?: StorageService) {
  const router = Router();
  const svc = companyService(db);
  const agents = agentService(db);
  const portability = companyPortabilityService(db, storage);
  const access = accessService(db);
  const budgets = budgetService(db);
  const actionPolicies = agentActionPolicyService(db);

  function assertImportTargetAccess(
    req: Request,
    target: { mode: "new_company" } | { mode: "existing_company"; companyId: string },
  ) {
    if (target.mode === "new_company") {
      assertInstanceAdmin(req);
      return;
    }
    assertCompanyAccess(req, target.companyId);
  }

  async function assertCanUpdateBranding(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") return;
    if (!req.actor.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    if (actorAgent.role !== "ceo") {
      throw forbidden("Only CEO agents can update company branding");
    }
  }

  async function assertCanManagePortability(req: Request, companyId: string, capability: "imports" | "exports") {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") return;
    if (!req.actor.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    if (actorAgent.role !== "ceo") {
      throw forbidden(`Only CEO agents can manage company ${capability}`);
    }
  }

  // An export copies every file in each exported agent's instructions folder.
  // A folder outside Paperclip's own storage can be anywhere on the host, so
  // exporting such an agent needs an instance admin, as upstream. This judges
  // the same agents the export will take.
  async function assertExternalInstructionExportAllowed(
    req: Request,
    companyId: string,
    input: { include?: { agents?: boolean }; agents?: string[] },
  ) {
    if (hasInstanceAdminAccess(req)) return;
    const includesAgents = input.agents && input.agents.length > 0
      ? true
      : input.include?.agents ?? true;
    if (!includesAgents) return;
    const companyAgents = await agents.list(companyId, { includeTerminated: true });
    const selection = resolvePortableExportAgentSelection(companyAgents, input.agents, includesAgents);
    for (const agent of selection.agents) {
      if (await agentInstructionsBundleMode(agent) === "external") {
        throw forbidden("Only an instance admin can export an agent whose instructions are kept outside Paperclip.");
      }
    }
  }

  router.get("/", async (req, res) => {
    assertAuthenticated(req);
    const result = await svc.list();

    /**
     * Strip out other people's personal companies.
     *
     * Every branch below hands back more than the caller's own memberships —
     * that is the point of them, for HQ roll-ups and administration. Without
     * this, an administrator's company list would name every user's Personal.
     * Not being able to open it is not enough; its existence and its issue
     * count are already more than "you cannot see anything in my personal".
     */
    const mine = (companies: typeof result) =>
      excludeOthersPersonalCompanies(companies, viewerUserIdForPersonalCheck(req.actor));

    // HQ agent (cross-company read via membership in portfolio root)
    if (req.actor.type === "agent" && req.actor.isPortfolioRootAgent) {
      // An HQ agent has no user identity, so no personal company is ever its
      // own — every one of them is somebody else's.
      res.json(mine(result));
      return;
    }
    assertBoard(req);
    if (req.actor.source === "local_implicit") {
      // Single-operator install: one person, nothing to hide from them.
      res.json(result);
      return;
    }
    if (req.actor.isInstanceAdmin || req.actor.isPortfolioRootUserAdmin) {
      res.json(mine(result));
      return;
    }
    const allowed = new Set(req.actor.companyIds ?? []);
    res.json(mine(result.filter((company) => allowed.has(company.id))));
  });

  router.get("/stats", async (req, res) => {
    assertAuthenticated(req);
    const stats = await svc.stats();

    // Other people's personal companies come out here too, for the reason the
    // list above gives: a company's issue count is already more than "you
    // cannot see anything in my personal".
    const mine = (byCompany: typeof stats) =>
      Object.fromEntries(
        excludeOthersPersonalCompanies(
          Object.entries(byCompany).map(([id, counts]) => ({ id, counts })),
          viewerUserIdForPersonalCheck(req.actor),
        ).map(({ id, counts }) => [id, counts]),
      );

    // HQ agent: full portfolio stats (cross-company read)
    if (req.actor.type === "agent" && req.actor.isPortfolioRootAgent) {
      res.json(mine(stats));
      return;
    }
    assertBoard(req);
    const allowed =
      req.actor.source === "local_implicit" ||
      req.actor.isInstanceAdmin ||
      req.actor.isPortfolioRootUserAdmin
        ? null
        : new Set(req.actor.companyIds ?? []);
    if (!allowed) {
      // The single local operator still sees everything, as in the list above.
      res.json(req.actor.source === "local_implicit" ? stats : mine(stats));
      return;
    }
    const filtered = Object.fromEntries(Object.entries(stats).filter(([companyId]) => allowed.has(companyId)));
    res.json(mine(filtered));
  });

  // Common malformed path when companyId is empty in "/api/companies/{companyId}/issues".
  router.get("/issues", (_req, res) => {
    res.status(400).json({
      error: "Missing companyId in path. Use /api/companies/{companyId}/issues.",
    });
  });

  router.get("/:companyId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    // Allow agents (CEO) to read their own company; board always allowed
    if (req.actor.type !== "agent") {
      assertBoard(req);
    }
    const company = await svc.getById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json(company);
  });

  router.post("/:companyId/export", validate(companyPortabilityExportSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanManagePortability(req, companyId, "exports");
    await assertExternalInstructionExportAllowed(req, companyId, req.body);
    const result = await portability.exportBundle(companyId, req.body);
    res.json(result);
  });

  router.post("/import/preview", validate(companyPortabilityPreviewSchema), async (req, res) => {
    assertBoard(req);
    assertImportTargetAccess(req, req.body.target);
    const preview = await portability.previewImport(req.body);
    res.json(preview);
  });

  router.post("/import", validate(companyPortabilityImportSchema), async (req, res) => {
    assertBoard(req);
    assertImportTargetAccess(req, req.body.target);
    const actor = getActorInfo(req);
    const result = await portability.importBundle(req.body, req.actor.type === "board" ? req.actor.userId : null);
    await logActivity(db, {
      companyId: result.company.id,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "company.imported",
      entityType: "company",
      entityId: result.company.id,
      agentId: actor.agentId,
      runId: actor.runId,
      details: {
        include: req.body.include ?? null,
        agentCount: result.agents.length,
        warningCount: result.warnings.length,
        companyAction: result.company.action,
      },
    });
    res.json(result);
  });

  router.post("/:companyId/exports/preview", validate(companyPortabilityExportSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanManagePortability(req, companyId, "exports");
    await assertExternalInstructionExportAllowed(req, companyId, req.body);
    const preview = await portability.previewExport(companyId, req.body);
    res.json(preview);
  });

  router.post("/:companyId/exports", validate(companyPortabilityExportSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanManagePortability(req, companyId, "exports");
    await assertExternalInstructionExportAllowed(req, companyId, req.body);
    const result = await portability.exportBundle(companyId, req.body);
    res.json(result);
  });

  router.post("/:companyId/imports/preview", validate(companyPortabilityPreviewSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanManagePortability(req, companyId, "imports");
    if (req.body.target.mode === "existing_company" && req.body.target.companyId !== companyId) {
      throw forbidden("Safe import route can only target the route company");
    }
    if (req.body.collisionStrategy === "replace") {
      throw forbidden("Safe import route does not allow replace collision strategy");
    }
    const preview = await portability.previewImport(req.body, {
      mode: "agent_safe",
      sourceCompanyId: companyId,
    });
    res.json(preview);
  });

  router.post("/:companyId/imports/apply", validate(companyPortabilityImportSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanManagePortability(req, companyId, "imports");
    if (req.body.target.mode === "existing_company" && req.body.target.companyId !== companyId) {
      throw forbidden("Safe import route can only target the route company");
    }
    if (req.body.collisionStrategy === "replace") {
      throw forbidden("Safe import route does not allow replace collision strategy");
    }
    const actor = getActorInfo(req);
    const result = await portability.importBundle(req.body, req.actor.type === "board" ? req.actor.userId : null, {
      mode: "agent_safe",
      sourceCompanyId: companyId,
    });
    await logActivity(db, {
      companyId: result.company.id,
      actorType: actor.actorType,
      actorId: actor.actorId,
      entityType: "company",
      entityId: result.company.id,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.imported",
      details: {
        include: req.body.include ?? null,
        agentCount: result.agents.length,
        warningCount: result.warnings.length,
        companyAction: result.company.action,
        importMode: "agent_safe",
      },
    });
    res.json(result);
  });

  router.post("/", validate(createCompanySchema), async (req, res) => {
    assertBoard(req);
    if (!(req.actor.source === "local_implicit" || req.actor.isInstanceAdmin)) {
      throw forbidden("Instance admin required");
    }
    const company = await svc.create(req.body);
    await access.ensureMembership(company.id, "user", req.actor.userId ?? "local-board", "owner", "active");
    await logActivity(db, {
      companyId: company.id,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "company.created",
      entityType: "company",
      entityId: company.id,
      details: { name: company.name },
    });
    if (company.budgetMonthlyCents > 0) {
      await budgets.upsertPolicy(
        company.id,
        {
          scopeType: "company",
          scopeId: company.id,
          amount: company.budgetMonthlyCents,
          windowKind: "calendar_month_utc",
        },
        req.actor.userId ?? "board",
      );
    }
    res.status(201).json(company);
  });

  router.get("/:companyId/agent-defaults", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId, "read");
    res.json(await companyAgentDefaultsService(db).get(companyId));
  });

  router.get("/:companyId/action-policies", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId, "read");
    const existingCompany = await svc.getById(companyId);
    if (!existingCompany) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json(await actionPolicies.listCompanyPolicies(companyId));
  });

  router.patch(
    "/:companyId/action-policies",
    validate(patchCompanyActionPolicySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const existingCompany = await svc.getById(companyId);
      if (!existingCompany) {
        res.status(404).json({ error: "Company not found" });
        return;
      }

      const { actionType, mode } = req.body;
      const actor = getActorInfo(req);
      const next = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const result = await agentActionPolicyService(txDb).updateCompanyPolicy(companyId, actionType, mode);
        await logActivity(txDb, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "company.action_policies_updated",
          entityType: "company",
          entityId: companyId,
          details: { actionType, mode, previous: result.previous, actionPolicies: result.next },
        });
        return result.next;
      });
      res.json(next);
    },
  );

  // Company defaults change what many agents may do at once, so only a board
  // user may set them (never an agent or tool session), and every change is
  // logged with the before and after values.
  router.patch(
    "/:companyId/agent-defaults",
    validate(patchCompanyAgentDefaultsSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const existingCompany = await svc.getById(companyId);
      if (!existingCompany) {
        res.status(404).json({ error: "Company not found" });
        return;
      }
      const actor = getActorInfo(req);
      const next = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const result = await companyAgentDefaultsService(txDb).update(companyId, req.body);
        await logActivity(txDb, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "company.agent_defaults_updated",
          entityType: "company",
          entityId: companyId,
          details: {
            previous: result.previous,
            agentDefaults: result.next,
            changedKeys: Object.keys(req.body).sort(),
          },
        });
        return result.next;
      });
      res.json(next);
    },
  );

  router.patch("/:companyId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const actor = getActorInfo(req);
    const existingCompany = await svc.getById(companyId);
    if (!existingCompany) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    let body: Record<string, unknown>;

    if (req.actor.type === "agent") {
      // Only CEO agents may update company branding fields
      const agentSvc = agentService(db);
      const actorAgent = req.actor.agentId ? await agentSvc.getById(req.actor.agentId) : null;
      if (!actorAgent || actorAgent.role !== "ceo") {
        throw forbidden("Only CEO agents or board users may update company settings");
      }
      if (actorAgent.companyId !== companyId) {
        throw forbidden("Agent key cannot access another company");
      }
      body = updateCompanyBrandingSchema.parse(req.body);
    } else {
      assertBoard(req);
      body = updateCompanySchema.parse(req.body);
    }

    const company = await svc.update(companyId, body);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.updated",
      entityType: "company",
      entityId: companyId,
      details: body,
    });
    res.json(company);
  });

  router.patch("/:companyId/branding", validate(updateCompanyBrandingSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanUpdateBranding(req, companyId);
    const company = await svc.update(companyId, req.body);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.branding_updated",
      entityType: "company",
      entityId: companyId,
      details: req.body,
    });
    res.json(company);
  });

  router.post("/:companyId/archive", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const target = await svc.getById(companyId);
    if (!target) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    if (target.isPortfolioRoot) {
      res.status(409).json({
        error: "[EROOT_UNDELETABLE] HQ (portfolio-root company) cannot be archived",
      });
      return;
    }
    if (target.kind === PERSONAL_COMPANY_KIND) {
      // Switch it off, yes; get rid of it, no. Personal ships with the
      // software and belongs to the user — pausing hides it without
      // destroying whatever they kept in there.
      res.status(409).json({
        error:
          "[EPERSONAL_UNDELETABLE] Your personal company can't be archived — pause it instead if you don't want to see it",
      });
      return;
    }
    const company = await svc.archive(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "company.archived",
      entityType: "company",
      entityId: companyId,
    });
    res.json(company);
  });

  router.delete("/:companyId", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const target = await svc.getById(companyId);
    if (!target) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    if (target.isPortfolioRoot) {
      res.status(409).json({
        error: "[EROOT_UNDELETABLE] HQ (portfolio-root company) cannot be deleted",
      });
      return;
    }
    if (target.kind === PERSONAL_COMPANY_KIND) {
      res.status(409).json({
        error:
          "[EPERSONAL_UNDELETABLE] Your personal company can't be deleted — pause it instead if you don't want to see it",
      });
      return;
    }
    const company = await svc.remove(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
