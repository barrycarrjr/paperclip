import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createMemorySchema,
  memoryListQuerySchema,
  updateMemorySchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity, memoryService } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function memoryRoutes(db: Db) {
  const router = Router();
  const svc = memoryService(db);

  router.get("/companies/:companyId/memories", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId, "read");
    const query = memoryListQuerySchema.parse(req.query);
    const rows = await svc.list(companyId, query);
    res.json(rows);
  });

  router.get("/memories/:id", async (req, res) => {
    const id = req.params.id as string;
    const memory = await svc.getById(id);
    if (!memory) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    assertCompanyAccess(req, memory.companyId, "read");
    res.json(memory);
  });

  router.post(
    "/companies/:companyId/memories",
    validate(createMemorySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const memory = await svc.create(companyId, req.body, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "memory.created",
        entityType: "memory",
        entityId: memory.id,
        details: { name: memory.name, kind: memory.kind },
      });
      res.status(201).json(memory);
    },
  );

  router.patch("/memories/:id", validate(updateMemorySchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const memory = await svc.update(id, req.body);
    if (!memory) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: memory.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "memory.updated",
      entityType: "memory",
      entityId: memory.id,
      details: req.body,
    });
    res.json(memory);
  });

  router.delete("/memories/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const memory = await svc.remove(id);
    if (!memory) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: memory.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "memory.deleted",
      entityType: "memory",
      entityId: memory.id,
    });
    res.json(memory);
  });

  return router;
}
