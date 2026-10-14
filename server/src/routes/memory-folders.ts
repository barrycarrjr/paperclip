import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { updateMemoryFolderSchema, applyDocumentLinksSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import { memoryFolderService, type MemoryFolderService } from "../services/memory-folder-sync.js";
import { assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "./authz.js";

/**
 * Per-company memory folder: where on disk a company's memories are mirrored
 * as Markdown, and the buttons that run an export, import or both.
 *
 * Changing the folder path writes to the server's filesystem, so only an
 * instance admin may set it. Running a sync needs ordinary company write
 * access.
 */
export function memoryFolderRoutes(db: Db, service: MemoryFolderService = memoryFolderService(db)) {
  const router = Router();

  router.get("/companies/:companyId/memory-folder", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await service.getSettings(companyId));
  });

  router.get("/companies/:companyId/memory-folder/findings", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await service.validate(companyId, "manual"));
  });

  router.get("/companies/:companyId/memory-folder/links/preview", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await service.previewLinks(companyId));
  });

  router.post("/companies/:companyId/memory-folder/links/apply", validate(applyDocumentLinksSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId,
      action: "memory_folder.links_apply_started", entityType: "memory_folder", entityId: companyId,
      details: { planHash: req.body.planHash, status: "started" },
    });
    try {
      const result = await service.applyLinks(companyId, req.body.planHash);
      await logActivity(db, {
        companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId,
        action: "memory_folder.links_applied", entityType: "memory_folder", entityId: companyId,
        details: { planHash: result.planHash, status: result.status, filesChanged: result.filesChanged, memoriesChanged: result.memoriesChanged },
      });
      res.json(result);
    } catch (error) {
      await logActivity(db, {
        companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId,
        action: "memory_folder.links_apply_failed", entityType: "memory_folder", entityId: companyId,
        details: { planHash: req.body.planHash, status: "failed" },
      });
      throw error;
    }
  });

  router.put(
    "/companies/:companyId/memory-folder",
    validate(updateMemoryFolderSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertInstanceAdmin(req);
      const settings = await service.updateSettings(companyId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "memory_folder.updated",
        entityType: "memory_folder",
        entityId: companyId,
        details: {
          path: settings.path,
          scheduleMinutes: settings.scheduleMinutes,
          driveLinkMode: settings.driveLinkMode,
        },
      });
      res.json(settings);
    },
  );

  for (const mode of ["export", "import", "sync"] as const) {
    router.post(`/companies/:companyId/memory-folder/${mode}`, async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await service[mode](companyId);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: `memory_folder.${mode}`,
        entityType: "memory_folder",
        entityId: companyId,
        details: {
          exported: result.exported,
          removed: result.removed,
          created: result.created,
          updated: result.updated,
          skipped: result.skipped,
          error: result.error,
        },
      });
      res.json(result);
    });
  }

  router.post("/companies/:companyId/memory-folder/index", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await service.rebuildIndex(companyId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "memory_folder.index_rebuilt",
      entityType: "memory_folder",
      entityId: companyId,
      details: { ...result },
    });
    res.json(result);
  });

  return router;
}
