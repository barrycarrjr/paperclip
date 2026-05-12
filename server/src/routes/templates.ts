import { Router, type Request } from "express";
import { z } from "zod";
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
import { templatesLibraryService } from "../services/templates-library.js";
import { badRequest, forbidden } from "../errors.js";
import { assertBoard, isUserDrivenActor } from "./authz.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const libraryInstallSchema = z.object({
  kind: z.enum(["agent", "routine", "skill"]),
  name: z.string().trim().min(1).max(120),
});

const libraryInstallBundleSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

const libraryUpdateSchema = z.object({
  kind: z.enum(["agent", "routine", "skill"]),
  name: z.string().trim().min(1).max(120),
});

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
  const lib = templatesLibraryService(db);

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

  // ===========================================================================
  // Templates Library — import from a GitHub release (paperclip-extensions)
  //
  // Sibling to /plugins/library. Lets the operator browse and install
  // pre-baked agent / routine / skill / bundle templates from the same
  // configured extensions repo. Imported rows carry a `source` JSONB so the
  // host can later flag upstream changes and re-sync.
  // ===========================================================================

  router.get("/templates/library", async (req, res) => {
    assertCanManageTemplates(req);
    try {
      const data = await lib.listLibrary();
      res.json(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: message });
    }
  });

  router.post("/templates/library/refresh", async (req, res) => {
    assertCanManageTemplates(req);
    lib.invalidate();
    try {
      const data = await lib.listLibrary();
      res.json(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: message });
    }
  });

  router.post("/templates/library/install", validate(libraryInstallSchema), async (req, res) => {
    assertCanManageTemplates(req);
    const { kind, name } = req.body as z.infer<typeof libraryInstallSchema>;
    try {
      const result = await lib.installSingle(kind, name, { userId: actorUserId(req) });
      res.status(result.status === "created" ? 201 : 200).json(result);
    } catch (err) {
      if (err instanceof Error && "statusCode" in err) throw err;
      throw badRequest(err instanceof Error ? err.message : String(err));
    }
  });

  router.post("/templates/library/update", validate(libraryUpdateSchema), async (req, res) => {
    assertCanManageTemplates(req);
    const { kind, name } = req.body as z.infer<typeof libraryUpdateSchema>;
    const result = await lib.updateFromLibrary(kind, name, { userId: actorUserId(req) });
    res.json({ status: "updated", template: result });
  });

  router.post(
    "/templates/library/install-bundle",
    validate(libraryInstallBundleSchema),
    async (req, res) => {
      assertCanManageTemplates(req);
      const { name } = req.body as z.infer<typeof libraryInstallBundleSchema>;
      const result = await lib.installBundle(name, { userId: actorUserId(req) });
      res.status(201).json(result);
    },
  );

  return router;
}
