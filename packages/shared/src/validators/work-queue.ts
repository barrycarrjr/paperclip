import { z } from "zod";

export const WORK_QUEUE_ITEM_STATUSES = [
  "pending",
  "claimed",
  "completed",
  "failed",
  "cancelled",
] as const;
export type WorkQueueItemStatus = (typeof WORK_QUEUE_ITEM_STATUSES)[number];

const slugRegex = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

export const workQueueSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(slugRegex, "Slug must be lowercase alphanumerics, hyphen, or underscore");

export const createWorkQueueSchema = z.object({
  slug: workQueueSlugSchema,
  name: z.string().min(1).max(200),
  description: z.string().max(1_000).optional().nullable(),
  defaultAssigneeAgentId: z.string().uuid().optional().nullable(),
  defaultProjectId: z.string().uuid().optional().nullable(),
  isActive: z.boolean().optional(),
});

export type CreateWorkQueue = z.infer<typeof createWorkQueueSchema>;

export const updateWorkQueueSchema = createWorkQueueSchema.partial().omit({ slug: true });

export type UpdateWorkQueue = z.infer<typeof updateWorkQueueSchema>;

export const enqueueWorkQueueItemSchema = z.object({
  payload: z.record(z.unknown()).optional(),
  externalSource: z.string().max(64).optional().nullable(),
  externalId: z.string().max(256).optional().nullable(),
  priority: z.number().int().min(-1000).max(1000).optional(),
});

export type EnqueueWorkQueueItem = z.infer<typeof enqueueWorkQueueItemSchema>;

export const completeWorkQueueItemSchema = z.object({
  payload: z.record(z.unknown()).optional(),
  issueId: z.string().uuid().optional().nullable(),
});

export type CompleteWorkQueueItem = z.infer<typeof completeWorkQueueItemSchema>;

export const failWorkQueueItemSchema = z.object({
  reason: z.string().min(1).max(2_000),
});

export type FailWorkQueueItem = z.infer<typeof failWorkQueueItemSchema>;

export const workQueueItemListQuerySchema = z.object({
  status: z.enum(WORK_QUEUE_ITEM_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export type WorkQueueItemListQuery = z.infer<typeof workQueueItemListQuerySchema>;
