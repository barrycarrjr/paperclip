import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { memories } from "@paperclipai/db";
import type { CreateMemory, UpdateMemory } from "@paperclipai/shared";
import { decryptTextAtRest, encryptTextAtRest } from "../secrets/local-encrypted-provider.js";

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

type MemoryRow = typeof memories.$inferSelect;

/**
 * Memory content is encrypted at rest with the instance secrets master key
 * (the same key that protects company secrets). Rows written before this
 * existed are plaintext and still read back unchanged.
 */
function reveal<T extends MemoryRow | null | undefined>(row: T): T {
  if (!row) return row;
  return { ...row, content: decryptTextAtRest(row.content) } as T;
}

function revealAll(rows: MemoryRow[]): MemoryRow[] {
  return rows.map((row) => reveal(row));
}

export function memoryService(db: Db) {
  return {
    list: async (companyId: string, filter: MemoryListFilter = {}) => {
      const conditions = [eq(memories.companyId, companyId)];
      if (filter.kind) conditions.push(eq(memories.kind, filter.kind));
      if (filter.agentId) conditions.push(eq(memories.agentId, filter.agentId));
      const limit = normalizeLimit(filter.limit);
      if (!filter.q) {
        const rows = await db
          .select()
          .from(memories)
          .where(and(...conditions))
          .orderBy(desc(memories.updatedAt))
          .limit(limit);
        return revealAll(rows);
      }
      // Content is ciphertext in the database, so a text search has to
      // decrypt first. Memory sets are small; read the company's rows and
      // filter here.
      const rows = await db
        .select()
        .from(memories)
        .where(and(...conditions))
        .orderBy(desc(memories.updatedAt))
        .limit(MAX_LIMIT);
      const needle = filter.q.toLowerCase();
      return revealAll(rows)
        .filter(
          (row) =>
            row.name.toLowerCase().includes(needle) ||
            (row.description ?? "").toLowerCase().includes(needle) ||
            row.content.toLowerCase().includes(needle),
        )
        .slice(0, limit);
    },

    getById: (id: string) =>
      db
        .select()
        .from(memories)
        .where(eq(memories.id, id))
        .then((rows) => reveal(rows[0] ?? null)),

    /** Find a company-level (no agent) memory by exact name. */
    getCompanyMemoryByName: (companyId: string, name: string) =>
      db
        .select()
        .from(memories)
        .where(
          and(
            eq(memories.companyId, companyId),
            isNull(memories.agentId),
            eq(memories.name, name),
          ),
        )
        .then((rows) => reveal(rows[0] ?? null)),

    create: (companyId: string, data: CreateMemory, actor: MemoryActor) =>
      db
        .insert(memories)
        .values({
          companyId,
          agentId: data.agentId ?? null,
          kind: data.kind,
          name: data.name,
          description: data.description ?? null,
          content: encryptTextAtRest(data.content),
          createdByAgentId: actor.agentId,
          createdByUserId: actor.userId,
        })
        .returning()
        .then((rows) => reveal(rows[0])),

    update: (id: string, data: UpdateMemory) => {
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (data.kind !== undefined) patch.kind = data.kind;
      if (data.name !== undefined) patch.name = data.name;
      if (data.description !== undefined) patch.description = data.description ?? null;
      if (data.content !== undefined) patch.content = encryptTextAtRest(data.content);
      return db
        .update(memories)
        .set(patch)
        .where(eq(memories.id, id))
        .returning()
        .then((rows) => reveal(rows[0] ?? null));
    },

    upsertByName: (
      companyId: string,
      data: CreateMemory & { agentId?: string | null },
      actor: MemoryActor,
    ) => {
      const content = encryptTextAtRest(data.content);
      return db
        .insert(memories)
        .values({
          companyId,
          agentId: data.agentId ?? null,
          kind: data.kind,
          name: data.name,
          description: data.description ?? null,
          content,
          createdByAgentId: actor.agentId,
          createdByUserId: actor.userId,
        })
        .onConflictDoUpdate({
          target: [memories.companyId, memories.agentId, memories.name],
          set: {
            kind: data.kind,
            description: data.description ?? null,
            content,
            updatedAt: sql`now()`,
          },
        })
        .returning()
        .then((rows) => reveal(rows[0]));
    },

    remove: (id: string) =>
      db
        .delete(memories)
        .where(eq(memories.id, id))
        .returning()
        .then((rows) => reveal(rows[0] ?? null)),
  };
}

export type MemoryService = ReturnType<typeof memoryService>;
