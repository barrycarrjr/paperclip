import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { issueComments, issues } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
  addApprovalCommentSchema,
  createApprovalSchema,
  instructionChangePayloadSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
  resubmitApprovalSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import {
  approvalService,
  companyService,
  issueApprovalService,
  logActivity,
  secretService,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import {
  excludeOthersPersonalCompanies,
  viewerUserIdForPersonalCheck,
} from "../services/personal-companies.js";
import { redactEventPayload } from "../redaction.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import type { PluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import { approvalDecisionService } from "../services/approval-decisions.js";
import { instructionRuleService } from "../services/instruction-rules.js";

function redactApprovalPayload<T extends { payload: Record<string, unknown> }>(approval: T): T {
  return {
    ...approval,
    payload: redactEventPayload(approval.payload) ?? {},
  };
}

export function approvalRoutes(
  db: Db,
  options: {
    pluginWorkerManager?: PluginWorkerManager;
    /**
     * Lazy reference to the tool dispatcher — used to re-dispatch
     * `outbound_tool_draft` approvals when a user approves them. Lazy
     * because the dispatcher is constructed after this route is mounted.
     */
    getToolDispatcher?: () => PluginToolDispatcher | null;
  } = {},
) {
  const router = Router();
  const svc = approvalService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const instructionRulesSvc = instructionRuleService(db);
  const secretsSvc = secretService(db);
  const decisions = approvalDecisionService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
    getToolDispatcher: options.getToolDispatcher,
  });
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";

  async function requireApprovalAccess(req: Request, id: string) {
    const approval = await svc.getById(id);
    if (!approval) {
      return null;
    }
    assertCompanyAccess(req, approval.companyId);
    return approval;
  }

  router.get("/companies/:companyId/approvals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const status = req.query.status as string | undefined;
    const result = await svc.list(companyId, status);
    res.json(result.map((approval) => redactApprovalPayload(approval)));
  });

  router.get("/companies/:companyId/portfolio-approvals", async (req, res) => {
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

    const statusFilter = (req.query.status as string | undefined) ?? "pending";
    const companyIdsFilter = req.query.companyIds as string | undefined;

    const allCompanies = excludeOthersPersonalCompanies(
      await companySvc.list(),
      viewerUserIdForPersonalCheck(req.actor),
    );
    let targetCompanies = allCompanies.filter((c) => c.status !== "archived");
    if (companyIdsFilter) {
      const allowed = new Set(companyIdsFilter.split(",").map((id) => id.trim()).filter(Boolean));
      targetCompanies = targetCompanies.filter((c) => allowed.has(c.id));
    }

    const approvalArrays = await Promise.all(
      targetCompanies.map((company) => svc.list(company.id, statusFilter)),
    );
    const allApprovals = approvalArrays.flat().map((a) => redactApprovalPayload(a));

    res.json({ approvals: allApprovals, companies: targetCompanies });
  });

  router.get("/approvals/:id", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    res.json(redactApprovalPayload(approval));
  });

  router.post("/companies/:companyId/approvals", validate(createApprovalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rawIssueIds = req.body.issueIds;
    const issueIds = Array.isArray(rawIssueIds)
      ? rawIssueIds.filter((value: unknown): value is string => typeof value === "string")
      : [];
    let uniqueIssueIds = Array.from(new Set(issueIds));
    const { issueIds: _issueIds, ...approvalInput } = req.body;
    let normalizedPayload =
      approvalInput.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            companyId,
            approvalInput.payload,
            { strictMode: strictSecretsMode },
          )
        : approvalInput.payload;

    const actor = getActorInfo(req);
    if (approvalInput.type === "instruction_change") {
      if (req.actor.type !== "agent" || !actor.agentId) {
        res.status(403).json({ error: "Instruction changes must be drafted by the corrected agent" });
        return;
      }
      const parsedPayload = instructionChangePayloadSchema.safeParse(normalizedPayload);
      if (!parsedPayload.success) {
        res.status(400).json({ error: "Invalid instruction change payload", details: parsedPayload.error.flatten() });
        return;
      }
      const payload = parsedPayload.data;
      if (payload.targetAgentId !== actor.agentId) {
        res.status(403).json({ error: "Agents can only propose instruction changes for themselves" });
        return;
      }
      if (approvalInput.requestedByAgentId && approvalInput.requestedByAgentId !== actor.agentId) {
        res.status(403).json({ error: "The approval requester must be the corrected agent" });
        return;
      }
      const source = await db
        .select({
          commentId: issueComments.id,
          commentIntent: issueComments.intent,
          commentAuthorUserId: issueComments.authorUserId,
          issueId: issues.id,
          issueCompanyId: issues.companyId,
          assigneeAgentId: issues.assigneeAgentId,
        })
        .from(issueComments)
        .innerJoin(issues, eq(issues.id, issueComments.issueId))
        .where(and(
          eq(issueComments.id, payload.sourceCommentId),
          eq(issueComments.companyId, companyId),
          eq(issues.id, payload.sourceIssueId),
          eq(issues.companyId, companyId),
        ))
        .then((rows) => rows[0] ?? null);
      if (!source || source.commentIntent !== "correction" || !source.commentAuthorUserId) {
        res.status(422).json({ error: "Instruction changes require a board-authored correction comment" });
        return;
      }
      if (source.assigneeAgentId !== actor.agentId) {
        res.status(409).json({ error: "The correction is no longer assigned to the requesting agent" });
        return;
      }
      normalizedPayload = payload;
      uniqueIssueIds = [payload.sourceIssueId];
    }
    const result = approvalInput.type === "instruction_change"
      ? await instructionRulesSvc.create({
          companyId,
          payload: instructionChangePayloadSchema.parse(normalizedPayload),
          requestedByAgentId: actor.agentId!,
          linkedIssueIds: uniqueIssueIds,
        })
      : {
          approval: await svc.create(companyId, {
            ...approvalInput,
            payload: normalizedPayload,
            requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
            requestedByAgentId:
              approvalInput.requestedByAgentId ?? (actor.actorType === "agent" ? actor.actorId : null),
            status: "pending",
            decisionNote: null,
            decidedByUserId: null,
            decidedAt: null,
            updatedAt: new Date(),
          }),
          created: true,
        };
    const approval = result.approval;

    if (result.created && approvalInput.type !== "instruction_change" && uniqueIssueIds.length > 0) {
      await issueApprovalsSvc.linkManyForApproval(approval.id, uniqueIssueIds, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });
    }

    if (result.created && approvalInput.type !== "instruction_change") {
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "approval.created",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type, issueIds: uniqueIssueIds },
      });
    }

    res.status(result.created ? 201 : 200).json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/issues", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    const issues = await issueApprovalsSvc.listIssuesForApproval(id);
    res.json(issues);
  });

  router.post("/approvals/:id/approve", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await requireApprovalAccess(req, id))) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const decidedByUserId = req.actor.userId ?? "board";
    // Everything that follows a decision lives in the approval decision
    // service, shared with the plugin host method `approvals.respond`, so a
    // decision made from a channel such as Slack does exactly what this does.
    const { approval } = await decisions.approve({
      approvalId: id,
      decidedByUserId,
      decisionNote: req.body.decisionNote,
    });

    res.json(redactApprovalPayload(approval));
  });

  router.post("/approvals/:id/reject", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await requireApprovalAccess(req, id))) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const decidedByUserId = req.actor.userId ?? "board";
    const { approval } = await decisions.reject({
      approvalId: id,
      decidedByUserId,
      decisionNote: req.body.decisionNote,
    });

    res.json(redactApprovalPayload(approval));
  });

  router.post(
    "/approvals/:id/request-revision",
    validate(requestApprovalRevisionSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      const existing = await requireApprovalAccess(req, id);
      if (!existing) {
        res.status(404).json({ error: "Approval not found" });
        return;
      }
      if (
        existing.type === "instruction_change" &&
        (typeof req.body.decisionNote !== "string" || !req.body.decisionNote.trim())
      ) {
        res.status(422).json({ error: "A revision note is required for instruction changes" });
        return;
      }
      const decidedByUserId = req.actor.userId ?? "board";
      const { approval } = await decisions.requestRevision({
        approvalId: id,
        decidedByUserId,
        decisionNote: req.body.decisionNote,
      });

      res.json(redactApprovalPayload(approval));
    },
  );

  router.post("/approvals/:id/resubmit", validate(resubmitApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    if (req.actor.type === "agent" && req.actor.agentId !== existing.requestedByAgentId) {
      res.status(403).json({ error: "Only requesting agent can resubmit this approval" });
      return;
    }

    let normalizedPayload = req.body.payload
      ? existing.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            existing.companyId,
            req.body.payload,
            { strictMode: strictSecretsMode },
          )
        : req.body.payload
      : undefined;
    if (existing.type === "instruction_change") {
      if (req.actor.type !== "agent" || req.actor.agentId !== existing.requestedByAgentId) {
        res.status(403).json({ error: "Only the corrected agent can revise this instruction change" });
        return;
      }
      if (typeof req.body.revisionCycle !== "string" || !req.body.revisionCycle) {
        res.status(422).json({ error: "The instruction revision cycle is required" });
        return;
      }
      const previous = instructionChangePayloadSchema.safeParse(existing.payload);
      const next = instructionChangePayloadSchema.safeParse(normalizedPayload ?? existing.payload);
      if (!previous.success || !next.success) {
        res.status(400).json({ error: "Invalid instruction change payload" });
        return;
      }
      if (
        next.data.targetAgentId !== previous.data.targetAgentId ||
        next.data.sourceIssueId !== previous.data.sourceIssueId ||
        next.data.sourceCommentId !== previous.data.sourceCommentId
      ) {
        res.status(422).json({ error: "A revised rule cannot change its agent or source correction" });
        return;
      }
      const source = await db
        .select({ intent: issueComments.intent, authorUserId: issueComments.authorUserId, assigneeAgentId: issues.assigneeAgentId })
        .from(issueComments)
        .innerJoin(issues, eq(issues.id, issueComments.issueId))
        .where(and(
          eq(issueComments.id, next.data.sourceCommentId),
          eq(issueComments.issueId, next.data.sourceIssueId),
          eq(issueComments.companyId, existing.companyId),
          eq(issues.companyId, existing.companyId),
        ))
        .then((rows) => rows[0] ?? null);
      if (!source || source.intent !== "correction" || !source.authorUserId || source.assigneeAgentId !== req.actor.agentId) {
        res.status(409).json({ error: "The source correction is no longer assigned to this agent" });
        return;
      }
      normalizedPayload = next.data;
    }
    const approval = existing.type === "instruction_change"
      ? await instructionRulesSvc.resubmit(
          id,
          instructionChangePayloadSchema.parse(normalizedPayload ?? existing.payload),
          req.body.revisionCycle,
        )
      : await svc.resubmit(id, normalizedPayload);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.resubmitted",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type },
    });
    res.json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    const comments = await svc.listComments(id);
    res.json(comments);
  });

  router.post("/approvals/:id/comments", validate(addApprovalCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    const actor = getActorInfo(req);
    const comment = await svc.addComment(id, req.body.body, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
    });

    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.comment_added",
      entityType: "approval",
      entityId: approval.id,
      details: { commentId: comment.id },
    });

    res.status(201).json(comment);
  });

  return router;
}
