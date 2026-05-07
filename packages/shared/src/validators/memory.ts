import { z } from "zod";

export const MEMORY_KINDS = ["user", "feedback", "project", "reference"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_NAME_MAX = 200;
export const MEMORY_DESCRIPTION_MAX = 500;
export const MEMORY_CONTENT_MAX = 32_000;

export const memoryKindSchema = z.enum(MEMORY_KINDS);

export const createMemorySchema = z.object({
  kind: memoryKindSchema,
  name: z.string().min(1).max(MEMORY_NAME_MAX),
  description: z.string().max(MEMORY_DESCRIPTION_MAX).optional().nullable(),
  content: z.string().min(1).max(MEMORY_CONTENT_MAX),
  agentId: z.string().uuid().optional().nullable(),
});

export type CreateMemory = z.infer<typeof createMemorySchema>;

export const updateMemorySchema = z.object({
  kind: memoryKindSchema.optional(),
  name: z.string().min(1).max(MEMORY_NAME_MAX).optional(),
  description: z.string().max(MEMORY_DESCRIPTION_MAX).optional().nullable(),
  content: z.string().min(1).max(MEMORY_CONTENT_MAX).optional(),
});

export type UpdateMemory = z.infer<typeof updateMemorySchema>;

export const memoryListQuerySchema = z.object({
  kind: memoryKindSchema.optional(),
  agentId: z.string().uuid().optional(),
  q: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export type MemoryListQuery = z.infer<typeof memoryListQuerySchema>;
