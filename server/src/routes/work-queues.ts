import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  completeWorkQueueItemSchema,
  createWorkQueueSchema,
  enqueueWorkQueueItemSchema,
  failWorkQueueItemSchema,
  updateWorkQueueSchema,
  workQueueItemListQuerySchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { conflict, forbidden, unprocessable } from "../errors.js";
import {
  WorkQueueClaimRaceError,
  logActivity,
  workQueueService,
} from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function workQueueRoutes(db: Db) {
  const router = Router();
  const svc = workQueueService(db);

  router.get("/companies/:companyId/work-queues", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId, "read");
    const rows = await svc.listQueues(companyId);
    res.json(rows);
  });

  router.post(
    "/companies/:companyId/work-queues",
    validate(createWorkQueueSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const queue = await svc.createQueue(companyId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "work_queue.created",
        entityType: "work_queue",
        entityId: queue.id,
        details: { slug: queue.slug, name: queue.name },
      });
      res.status(201).json(queue);
    },
  );

  router.get("/work-queues/:id", async (req, res) => {
    const id = req.params.id as string;
    const queue = await svc.getQueueById(id);
    if (!queue) {
      res.status(404).json({ error: "Work queue not found" });
      return;
    }
    assertCompanyAccess(req, queue.companyId, "read");
    res.json(queue);
  });

  router.patch("/work-queues/:id", validate(updateWorkQueueSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getQueueById(id);
    if (!existing) {
      res.status(404).json({ error: "Work queue not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const queue = await svc.updateQueue(id, req.body);
    if (!queue) {
      res.status(404).json({ error: "Work queue not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: queue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "work_queue.updated",
      entityType: "work_queue",
      entityId: queue.id,
      details: req.body,
    });
    res.json(queue);
  });

  router.delete("/work-queues/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getQueueById(id);
    if (!existing) {
      res.status(404).json({ error: "Work queue not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const queue = await svc.deleteQueue(id);
    if (!queue) {
      res.status(404).json({ error: "Work queue not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: queue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "work_queue.deleted",
      entityType: "work_queue",
      entityId: queue.id,
    });
    res.json(queue);
  });

  router.get("/work-queues/:id/items", async (req, res) => {
    const id = req.params.id as string;
    const queue = await svc.getQueueById(id);
    if (!queue) {
      res.status(404).json({ error: "Work queue not found" });
      return;
    }
    assertCompanyAccess(req, queue.companyId, "read");
    const filter = workQueueItemListQuerySchema.parse(req.query);
    const items = await svc.listItems(id, filter);
    res.json(items);
  });

  router.post(
    "/work-queues/:id/items",
    validate(enqueueWorkQueueItemSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const queue = await svc.getQueueById(id);
      if (!queue) {
        res.status(404).json({ error: "Work queue not found" });
        return;
      }
      assertCompanyAccess(req, queue.companyId);
      if (!queue.isActive) {
        throw unprocessable("Work queue is not active");
      }
      const item = await svc.enqueue(id, queue.companyId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: queue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "work_queue.item.enqueued",
        entityType: "work_queue_item",
        entityId: item.id,
        details: { queueId: id, externalSource: item.externalSource, externalId: item.externalId },
      });
      res.status(201).json(item);
    },
  );

  router.get("/work-queue-items/:itemId", async (req, res) => {
    const itemId = req.params.itemId as string;
    const item = await svc.getItemById(itemId);
    if (!item) {
      res.status(404).json({ error: "Work queue item not found" });
      return;
    }
    assertCompanyAccess(req, item.companyId, "read");
    res.json(item);
  });

  router.post("/work-queue-items/:itemId/claim", async (req, res) => {
    const itemId = req.params.itemId as string;
    const item = await svc.getItemById(itemId);
    if (!item) {
      res.status(404).json({ error: "Work queue item not found" });
      return;
    }
    assertCompanyAccess(req, item.companyId);
    const actor = getActorInfo(req);
    if (!actor.agentId) {
      throw forbidden("Only agents can claim work queue items");
    }
    try {
      const claimed = await svc.claim(itemId, actor.agentId);
      await logActivity(db, {
        companyId: item.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "work_queue.item.claimed",
        entityType: "work_queue_item",
        entityId: claimed.id,
      });
      res.json(claimed);
    } catch (err) {
      if (err instanceof WorkQueueClaimRaceError) {
        throw conflict("Work queue item is no longer pending");
      }
      throw err;
    }
  });

  router.post(
    "/work-queue-items/:itemId/complete",
    validate(completeWorkQueueItemSchema),
    async (req, res) => {
      const itemId = req.params.itemId as string;
      const item = await svc.getItemById(itemId);
      if (!item) {
        res.status(404).json({ error: "Work queue item not found" });
        return;
      }
      assertCompanyAccess(req, item.companyId);
      const actor = getActorInfo(req);
      if (actor.agentId && item.claimedByAgentId && item.claimedByAgentId !== actor.agentId) {
        throw forbidden("Agent did not claim this work queue item");
      }
      const completed = await svc.complete(itemId, req.body);
      await logActivity(db, {
        companyId: item.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "work_queue.item.completed",
        entityType: "work_queue_item",
        entityId: completed.id,
      });
      res.json(completed);
    },
  );

  router.post(
    "/work-queue-items/:itemId/fail",
    validate(failWorkQueueItemSchema),
    async (req, res) => {
      const itemId = req.params.itemId as string;
      const item = await svc.getItemById(itemId);
      if (!item) {
        res.status(404).json({ error: "Work queue item not found" });
        return;
      }
      assertCompanyAccess(req, item.companyId);
      const actor = getActorInfo(req);
      if (actor.agentId && item.claimedByAgentId && item.claimedByAgentId !== actor.agentId) {
        throw forbidden("Agent did not claim this work queue item");
      }
      const failed = await svc.fail(itemId, req.body);
      await logActivity(db, {
        companyId: item.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "work_queue.item.failed",
        entityType: "work_queue_item",
        entityId: failed.id,
        details: { reason: req.body.reason },
      });
      res.json(failed);
    },
  );

  router.post("/work-queue-items/:itemId/cancel", async (req, res) => {
    const itemId = req.params.itemId as string;
    const item = await svc.getItemById(itemId);
    if (!item) {
      res.status(404).json({ error: "Work queue item not found" });
      return;
    }
    assertCompanyAccess(req, item.companyId);
    const cancelled = await svc.cancel(itemId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: item.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "work_queue.item.cancelled",
      entityType: "work_queue_item",
      entityId: cancelled.id,
    });
    res.json(cancelled);
  });

  return router;
}
