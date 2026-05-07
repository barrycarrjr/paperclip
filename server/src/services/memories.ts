import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { memories } from "@paperclipai/db";
import type { CreateMemory, UpdateMemory } from "@paperclipai/shared";

export interface MemoryListFilter {
  kind?: string;
  agentId?: string;
  q?: string;
  limit?: number;
}

export interface MemoryActor {
  agentId: string | null;
  userId: string | null;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit ?? NaN)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit ?? DEFAULT_LIMIT)));
}

export function memoryService(db: Db) {
  return {
    list: (companyId: string, filter: MemoryListFilter = {}) => {
      const conditions = [eq(memories.companyId, companyId)];
      if (filter.kind) conditions.push(eq(memories.kind, filter.kind));
      if (filter.agentId) conditions.push(eq(memories.agentId, filter.agentId));
      if (filter.q) {
        const needle = `%${filter.q}%`;
        conditions.push(
          or(
            ilike(memories.name, needle),
            ilike(memories.description, needle),
            ilike(memories.content, needle),
          )!,
        );
      }
      return db
        .select()
        .from(memories)
        .where(and(...conditions))
        .orderBy(desc(memories.updatedAt))
        .limit(normalizeLimit(filter.limit));
    },

    getById: (id: string) =>
      db
        .select()
        .from(memories)
        .where(eq(memories.id, id))
        .then((rows) => rows[0] ?? null),

    create: (companyId: string, data: CreateMemory, actor: MemoryActor) =>
      db
        .insert(memories)
        .values({
          companyId,
          agentId: data.agentId ?? null,
          kind: data.kind,
          name: data.name,
          description: data.description ?? null,
          content: data.content,
          createdByAgentId: actor.agentId,
          createdByUserId: actor.userId,
        })
        .returning()
        .then((rows) => rows[0]),

    update: (id: string, data: UpdateMemory) => {
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (data.kind !== undefined) patch.kind = data.kind;
      if (data.name !== undefined) patch.name = data.name;
      if (data.description !== undefined) patch.description = data.description ?? null;
      if (data.content !== undefined) patch.content = data.content;
      return db
        .update(memories)
        .set(patch)
        .where(eq(memories.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    upsertByName: (
      companyId: string,
      data: CreateMemory & { agentId?: string | null },
      actor: MemoryActor,
    ) =>
      db
        .insert(memories)
        .values({
          companyId,
          agentId: data.agentId ?? null,
          kind: data.kind,
          name: data.name,
          description: data.description ?? null,
          content: data.content,
          createdByAgentId: actor.agentId,
          createdByUserId: actor.userId,
        })
        .onConflictDoUpdate({
          target: [memories.companyId, memories.agentId, memories.name],
          set: {
            kind: data.kind,
            description: data.description ?? null,
            content: data.content,
            updatedAt: sql`now()`,
          },
        })
        .returning()
        .then((rows) => rows[0]),

    remove: (id: string) =>
      db
        .delete(memories)
        .where(eq(memories.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),
  };
}

export type MemoryService = ReturnType<typeof memoryService>;
