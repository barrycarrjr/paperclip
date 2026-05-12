import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  createAgentTemplateSchema,
  createRoutineTemplateSchema,
  createSkillTemplateSchema,
  deployTemplateSchema,
  templateTypeSchema,
  updateAgentTemplateSchema,
  updateRoutineTemplateSchema,
  updateSkillTemplateSchema,
  type TemplateType,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { templateService } from "../services/index.js";
import { forbidden } from "../errors.js";
import { assertBoard, isUserDrivenActor } from "./authz.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

function assertCanManageTemplates(req: Request) {
  assertBoard(req);
  if (req.actor.type !== "board") throw forbidden("Board access required");
  if (req.actor.source === "local_implicit") return;
  if (req.actor.isInstanceAdmin) return;
  if (req.actor.isPortfolioRootUserAdmin) return;
  throw forbidden("Instance or portfolio-root admin access required");
}

function parseType(value: unknown): TemplateType {
  const result = templateTypeSchema.safeParse(value);
  if (!result.success) {
    throw forbidden(`Unknown template type '${String(value)}'`);
  }
  return result.data;
}

function actorUserId(req: Request): string | null {
  if (isUserDrivenActor(req)) {
    return req.actor.type === "board" || req.actor.type === "tool_session"
      ? (req.actor.userId ?? null)
      : null;
  }
  return null;
}

export function templateRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const router = Router();
  const svc = templateService(db, { pluginWorkerManager: options.pluginWorkerManager });

  router.get("/templates/routine", async (req, res) => {
    assertCanManageTemplates(req);
    const result = await svc.listRoutineTemplates();
    res.json({ templates: result });
  });

  router.get("/templates/agent", async (req, res) => {
    assertCanManageTemplates(req);
    const result = await svc.listAgentTemplates();
    res.json({ templates: result });
  });

  router.get("/templates/skill", async (req, res) => {
    assertCanManageTemplates(req);
    const result = await svc.listSkillTemplates();
    res.json({ templates: result });
  });

  router.get("/templates/routine/:id", async (req, res) => {
    assertCanManageTemplates(req);
    const detail = await svc.getRoutineTemplate(req.params.id as string);
    if (!detail) {
      res.status(404).json({ error: "Routine template not found" });
      return;
    }
    res.json(detail);
  });

  router.get("/templates/agent/:id", async (req, res) => {
    assertCanManageTemplates(req);
    const detail = await svc.getAgentTemplate(req.params.id as string);
    if (!detail) {
      res.status(404).json({ error: "Agent template not found" });
      return;
    }
    res.json(detail);
  });

  router.get("/templates/skill/:id", async (req, res) => {
    assertCanManageTemplates(req);
    const detail = await svc.getSkillTemplate(req.params.id as string);
    if (!detail) {
      res.status(404).json({ error: "Skill template not found" });
      return;
    }
    res.json(detail);
  });

  router.post("/templates/routine", validate(createRoutineTemplateSchema), async (req, res) => {
    assertCanManageTemplates(req);
    const result = await svc.createRoutineTemplate(req.body, { userId: actorUserId(req) });
    res.status(201).json(result);
  });

  router.post("/templates/agent", validate(createAgentTemplateSchema), async (req, res) => {
    assertCanManageTemplates(req);
    const result = await svc.createAgentTemplate(req.body, { userId: actorUserId(req) });
    res.status(201).json(result);
  });

  router.post("/templates/skill", validate(createSkillTemplateSchema), async (req, res) => {
    assertCanManageTemplates(req);
    const result = await svc.createSkillTemplate(req.body, { userId: actorUserId(req) });
    res.status(201).json(result);
  });

  router.patch("/templates/routine/:id", validate(updateRoutineTemplateSchema), async (req, res) => {
    assertCanManageTemplates(req);
    const result = await svc.updateRoutineTemplate(
      req.params.id as string,
      req.body,
      { userId: actorUserId(req) },
    );
    if (!result) {
      res.status(404).json({ error: "Routine template not found" });
      return;
    }
    res.json(result);
  });

  router.patch("/templates/agent/:id", validate(updateAgentTemplateSchema), async (req, res) => {
    assertCanManageTemplates(req);
    const result = await svc.updateAgentTemplate(
      req.params.id as string,
      req.body,
      { userId: actorUserId(req) },
    );
    if (!result) {
      res.status(404).json({ error: "Agent template not found" });
      return;
    }
    res.json(result);
  });

  router.patch("/templates/skill/:id", validate(updateSkillTemplateSchema), async (req, res) => {
    assertCanManageTemplates(req);
    const result = await svc.updateSkillTemplate(
      req.params.id as string,
      req.body,
      { userId: actorUserId(req) },
    );
    if (!result) {
      res.status(404).json({ error: "Skill template not found" });
      return;
    }
    res.json(result);
  });

  router.delete("/templates/routine/:id", async (req, res) => {
    assertCanManageTemplates(req);
    const ok = await svc.deleteRoutineTemplate(req.params.id as string);
    if (!ok) {
      res.status(404).json({ error: "Routine template not found" });
      return;
    }
    res.status(204).end();
  });

  router.delete("/templates/agent/:id", async (req, res) => {
    assertCanManageTemplates(req);
    const ok = await svc.deleteAgentTemplate(req.params.id as string);
    if (!ok) {
      res.status(404).json({ error: "Agent template not found" });
      return;
    }
    res.status(204).end();
  });

  router.delete("/templates/skill/:id", async (req, res) => {
    assertCanManageTemplates(req);
    const ok = await svc.deleteSkillTemplate(req.params.id as string);
    if (!ok) {
      res.status(404).json({ error: "Skill template not found" });
      return;
    }
    res.status(204).end();
  });

  router.post(
    "/templates/:type/:id/deploy",
    validate(deployTemplateSchema),
    async (req, res) => {
      assertCanManageTemplates(req);
      const type = parseType(req.params.type);
      const result = await svc.deploy(
        type,
        req.params.id as string,
        req.body,
        { userId: actorUserId(req) },
      );
      res.status(200).json(result);
    },
  );

  router.get("/templates/:type/:id/deployments", async (req, res) => {
    assertCanManageTemplates(req);
    const type = parseType(req.params.type);
    const deployments = await svc.listDeployments(type, req.params.id as string);
    res.json({ deployments });
  });

  return router;
}
