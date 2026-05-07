import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workQueues, workQueueItems } from "@paperclipai/db";
import type {
  CompleteWorkQueueItem,
  CreateWorkQueue,
  EnqueueWorkQueueItem,
  FailWorkQueueItem,
  UpdateWorkQueue,
  WorkQueueItemListQuery,
  WorkQueueItemStatus,
} from "@paperclipai/shared";
import { conflict, unprocessable } from "../errors.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit ?? NaN)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit ?? DEFAULT_LIMIT)));
}

export class WorkQueueClaimRaceError extends Error {
  constructor() {
    super("Work queue item is no longer pending");
    this.name = "WorkQueueClaimRaceError";
  }
}

export function workQueueService(db: Db) {
  return {
    listQueues: (companyId: string) =>
      db.select().from(workQueues).where(eq(workQueues.companyId, companyId)),

    getQueueById: (id: string) =>
      db
        .select()
        .from(workQueues)
        .where(eq(workQueues.id, id))
        .then((rows) => rows[0] ?? null),

    createQueue: async (companyId: string, data: CreateWorkQueue) => {
      try {
        const [row] = await db
          .insert(workQueues)
          .values({
            companyId,
            slug: data.slug,
            name: data.name,
            description: data.description ?? null,
            defaultAssigneeAgentId: data.defaultAssigneeAgentId ?? null,
            defaultProjectId: data.defaultProjectId ?? null,
            isActive: data.isActive ?? true,
          })
          .returning();
        return row;
      } catch (err) {
        if (err instanceof Error && /work_queues_company_slug_uq/.test(err.message)) {
          throw conflict(`Work queue with slug "${data.slug}" already exists in this company`);
        }
        throw err;
      }
    },

    updateQueue: (id: string, data: UpdateWorkQueue) => {
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (data.name !== undefined) patch.name = data.name;
      if (data.description !== undefined) patch.description = data.description ?? null;
      if (data.defaultAssigneeAgentId !== undefined)
        patch.defaultAssigneeAgentId = data.defaultAssigneeAgentId ?? null;
      if (data.defaultProjectId !== undefined)
        patch.defaultProjectId = data.defaultProjectId ?? null;
      if (data.isActive !== undefined) patch.isActive = data.isActive;
      return db
        .update(workQueues)
        .set(patch)
        .where(eq(workQueues.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    deleteQueue: (id: string) =>
      db
        .delete(workQueues)
        .where(eq(workQueues.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    listItems: (queueId: string, filter: WorkQueueItemListQuery = {}) => {
      const conditions = [eq(workQueueItems.queueId, queueId)];
      if (filter.status) conditions.push(eq(workQueueItems.status, filter.status));
      return db
        .select()
        .from(workQueueItems)
        .where(and(...conditions))
        .orderBy(desc(workQueueItems.priority), asc(workQueueItems.createdAt))
        .limit(normalizeLimit(filter.limit));
    },

    getItemById: (id: string) =>
      db
        .select()
        .from(workQueueItems)
        .where(eq(workQueueItems.id, id))
        .then((rows) => rows[0] ?? null),

    enqueue: async (queueId: string, companyId: string, data: EnqueueWorkQueueItem) => {
      const externalSource = data.externalSource ?? null;
      const externalId = data.externalId ?? null;
      try {
        const [row] = await db
          .insert(workQueueItems)
          .values({
            queueId,
            companyId,
            externalSource,
            externalId,
            payload: data.payload ?? {},
            priority: data.priority ?? 0,
          })
          .returning();
        return row;
      } catch (err) {
        if (
          err instanceof Error &&
          /work_queue_items_queue_external_uq/.test(err.message) &&
          externalSource &&
          externalId
        ) {
          throw conflict(
            `Item with externalSource=${externalSource} externalId=${externalId} already exists in this queue`,
          );
        }
        throw err;
      }
    },

    claim: async (itemId: string, agentId: string) => {
      const [row] = await db
        .update(workQueueItems)
        .set({
          status: "claimed",
          claimedByAgentId: agentId,
          claimedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(workQueueItems.id, itemId), eq(workQueueItems.status, "pending")))
        .returning();
      if (!row) throw new WorkQueueClaimRaceError();
      return row;
    },

    complete: async (itemId: string, data: CompleteWorkQueueItem = {}) => {
      const patch: Record<string, unknown> = {
        status: "completed",
        completedAt: sql`now()`,
        updatedAt: sql`now()`,
      };
      if (data.payload !== undefined) patch.payload = data.payload;
      if (data.issueId !== undefined) patch.issueId = data.issueId ?? null;
      const [row] = await db
        .update(workQueueItems)
        .set(patch)
        .where(and(eq(workQueueItems.id, itemId), eq(workQueueItems.status, "claimed")))
        .returning();
      if (!row) throw unprocessable("Only claimed work queue items can be completed");
      return row;
    },

    fail: async (itemId: string, data: FailWorkQueueItem) => {
      const [row] = await db
        .update(workQueueItems)
        .set({
          status: "failed",
          failedAt: sql`now()`,
          failureReason: data.reason,
          updatedAt: sql`now()`,
        })
        .where(and(eq(workQueueItems.id, itemId), eq(workQueueItems.status, "claimed")))
        .returning();
      if (!row) throw unprocessable("Only claimed work queue items can be failed");
      return row;
    },

    cancel: async (itemId: string) => {
      const [row] = await db
        .update(workQueueItems)
        .set({ status: "cancelled", updatedAt: sql`now()` })
        .where(and(eq(workQueueItems.id, itemId), eq(workQueueItems.status, "pending")))
        .returning();
      if (!row) throw unprocessable("Only pending work queue items can be cancelled");
      return row;
    },
  };
}

export type WorkQueueService = ReturnType<typeof workQueueService>;

export type { WorkQueueItemStatus };
