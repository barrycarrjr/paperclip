import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, memoryFolders } from "@paperclipai/db";
import type {
  Memory,
  MemoryFolderRunResult,
  MemoryFolderSettings,
  UpdateMemoryFolder,
} from "@paperclipai/shared";
import { MEMORY_CONTENT_MAX, MEMORY_NAME_MAX } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { agentService } from "./agents.js";
import { memoryService } from "./memories.js";
import {
  INDEX_FILE,
  isSkippedFileName,
  memoryFileName,
  parseMemoryFile,
  serializeIndex,
  serializeMemoryFile,
  type IndexEntry,
} from "./memory-folder-markdown.js";

/**
 * Mirrors a company's memories to a folder of Markdown files and back.
 *
 * The `memories` table is the source of record. Export writes every memory
 * to `<folder>/<slug>.md` plus a `MEMORY.md` index, and removes files it
 * wrote earlier for memories that no longer exist. Import reads every other
 * `.md` file in the folder and creates or updates memories from it, taking a
 * file's content only when the file is newer than Paperclip's copy. A sync is
 * an import followed by an export, so a hand edit wins and the folder is left
 * in canonical form.
 */

export type MemoryFolderMode = MemoryFolderRunResult["mode"];
export type MemoryFolderTrigger = MemoryFolderRunResult["trigger"];

export interface MemoryFolderDeps {
  memories: Pick<ReturnType<typeof memoryService>, "list" | "create" | "update">;
  agents: { list(companyId: string): Promise<Array<{ id: string; name: string }>> };
  companyName(companyId: string): Promise<string>;
  now?: () => Date;
}

const LIST_LIMIT = 500;

export function expandHomePath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

export function normalizeFolderPath(input: string): string {
  const expanded = expandHomePath(input);
  if (!path.isAbsolute(expanded)) {
    throw unprocessable("Memory folder path must be an absolute path (or start with ~/)");
  }
  return path.normalize(expanded);
}

function emptyResult(mode: MemoryFolderMode, trigger: MemoryFolderTrigger, startedAt: Date): MemoryFolderRunResult {
  return {
    mode,
    trigger,
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    exported: 0,
    removed: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    warnings: [],
    error: null,
  };
}

function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "").replace(/\r\n/g, "\n").trim() === (b ?? "").replace(/\r\n/g, "\n").trim();
}

/**
 * Export every memory of a company to `folder`. Returns counts; never throws
 * for a single bad file, only for an unusable folder.
 */
export async function exportMemoriesToFolder(
  deps: MemoryFolderDeps,
  companyId: string,
  folder: string,
  result: MemoryFolderRunResult,
): Promise<void> {
  await fs.mkdir(folder, { recursive: true });
  const [rows, agents, companyName] = await Promise.all([
    deps.memories.list(companyId, { limit: LIST_LIMIT }),
    deps.agents.list(companyId),
    deps.companyName(companyId),
  ]);
  // `kind` is stored as text; every row was validated against MEMORY_KINDS on the way in.
  const memories = rows as Memory[];
  if (memories.length >= LIST_LIMIT) {
    result.warnings.push(`Only the ${LIST_LIMIT} most recently updated memories were exported.`);
  }
  const agentNameById = new Map(agents.map((a) => [a.id, a.name]));

  // Resolve file names, de-duplicating any slug collisions with a short id.
  const used = new Map<string, Memory>();
  const planned: Array<{ memory: Memory; fileName: string; agentName: string | null }> = [];
  for (const memory of memories) {
    const agentName = memory.agentId ? agentNameById.get(memory.agentId) ?? null : null;
    let fileName = memoryFileName(memory, agentName);
    if (used.has(fileName)) {
      fileName = fileName.replace(/\.md$/, `-${memory.id.slice(0, 8)}.md`);
    }
    used.set(fileName, memory);
    planned.push({ memory, fileName, agentName });
  }

  const liveIds = new Set(memories.map((m) => m.id));
  const keepFiles = new Set(planned.map((p) => p.fileName));

  // Remove files Paperclip wrote for memories that have since been deleted or
  // renamed. Files without a paperclip_id were written by a person or another
  // tool and are never removed here.
  const existing = await fs.readdir(folder, { withFileTypes: true });
  for (const entry of existing) {
    if (!entry.isFile() || isSkippedFileName(entry.name) || keepFiles.has(entry.name)) continue;
    const full = path.join(folder, entry.name);
    try {
      const parsed = parseMemoryFile(entry.name, await fs.readFile(full, "utf8"));
      if (parsed.paperclipId && !liveIds.has(parsed.paperclipId)) {
        await fs.unlink(full);
        result.removed += 1;
      }
    } catch (err) {
      result.warnings.push(`Could not read ${entry.name}: ${(err as Error).message}`);
    }
  }

  const indexEntries: IndexEntry[] = [];
  for (const { memory, fileName, agentName } of planned) {
    const text = serializeMemoryFile(memory, agentName);
    const full = path.join(folder, fileName);
    let current: string | null = null;
    try {
      current = await fs.readFile(full, "utf8");
    } catch {
      current = null;
    }
    if (current === null || current.replace(/\r\n/g, "\n") !== text) {
      await fs.writeFile(full, text, "utf8");
    }
    result.exported += 1;
    indexEntries.push({
      fileName,
      name: memory.name,
      kind: memory.kind,
      description: memory.description,
      agentName,
    });
  }

  await fs.writeFile(path.join(folder, INDEX_FILE), serializeIndex(companyName, indexEntries), "utf8");
}

/**
 * Import `.md` files from `folder` into the company's memories.
 */
export async function importMemoriesFromFolder(
  deps: MemoryFolderDeps,
  companyId: string,
  folder: string,
  result: MemoryFolderRunResult,
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(folder, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      result.warnings.push("Folder does not exist yet; nothing to import.");
      return;
    }
    throw err;
  }

  const [rows, agents] = await Promise.all([
    deps.memories.list(companyId, { limit: LIST_LIMIT }),
    deps.agents.list(companyId),
  ]);
  const memories = rows as Memory[];
  const agentIdByName = new Map(agents.map((a) => [a.name.trim().toLowerCase(), a.id]));
  const byId = new Map(memories.map((m) => [m.id, m]));
  const byScopeName = new Map(memories.map((m) => [`${m.agentId ?? ""}\u0000${m.name}`, m]));

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (isSkippedFileName(entry.name)) {
      if (/conflict/i.test(entry.name)) {
        result.warnings.push(`Skipped sync conflict file ${entry.name}; resolve it by hand.`);
        result.skipped += 1;
      }
      continue;
    }
    const full = path.join(folder, entry.name);
    try {
      const [text, stat] = await Promise.all([fs.readFile(full, "utf8"), fs.stat(full)]);
      const parsed = parseMemoryFile(entry.name, text);
      if (!parsed.content) {
        result.warnings.push(`Skipped ${entry.name}: it has no content.`);
        result.skipped += 1;
        continue;
      }
      if (parsed.content.length > MEMORY_CONTENT_MAX) {
        result.warnings.push(`Skipped ${entry.name}: longer than ${MEMORY_CONTENT_MAX} characters.`);
        result.skipped += 1;
        continue;
      }
      const name = parsed.name.slice(0, MEMORY_NAME_MAX);

      let agentId: string | null = null;
      if (parsed.agent) {
        agentId = agentIdByName.get(parsed.agent.trim().toLowerCase()) ?? null;
        if (!agentId) {
          result.warnings.push(
            `${entry.name} names agent "${parsed.agent}" which is not in this company; imported company-wide.`,
          );
        }
      }

      const existing =
        (parsed.paperclipId ? byId.get(parsed.paperclipId) : undefined) ??
        byScopeName.get(`${agentId ?? ""}\u0000${name}`);

      if (!existing) {
        const created = (await deps.memories.create(
          companyId,
          { kind: parsed.kind, name, description: parsed.description, content: parsed.content, agentId },
          { agentId: null, userId: null },
        )) as Memory;
        byId.set(created.id, created);
        byScopeName.set(`${created.agentId ?? ""}\u0000${created.name}`, created);
        result.created += 1;
        continue;
      }

      const unchanged =
        sameText(existing.content, parsed.content) &&
        existing.kind === parsed.kind &&
        sameText(existing.description, parsed.description) &&
        existing.name === name;
      if (unchanged) continue;

      if (stat.mtime.getTime() <= new Date(existing.updatedAt).getTime()) {
        // Paperclip's copy is newer; the following export rewrites the file.
        result.skipped += 1;
        continue;
      }

      await deps.memories.update(existing.id, {
        kind: parsed.kind,
        name,
        description: parsed.description,
        content: parsed.content,
      });
      result.updated += 1;
    } catch (err) {
      result.warnings.push(`Could not import ${entry.name}: ${(err as Error).message}`);
      result.skipped += 1;
    }
  }
}

export async function runMemoryFolder(
  deps: MemoryFolderDeps,
  companyId: string,
  folder: string,
  mode: MemoryFolderMode,
  trigger: MemoryFolderTrigger,
): Promise<MemoryFolderRunResult> {
  const now = deps.now ?? (() => new Date());
  const result = emptyResult(mode, trigger, now());
  try {
    if (mode === "import" || mode === "sync") {
      await importMemoriesFromFolder(deps, companyId, folder, result);
    }
    if (mode === "export" || mode === "sync") {
      await exportMemoriesToFolder(deps, companyId, folder, result);
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  result.finishedAt = now().toISOString();
  return result;
}

type FolderRow = typeof memoryFolders.$inferSelect;

function toSettings(companyId: string, row: FolderRow | null | undefined): MemoryFolderSettings {
  return {
    companyId,
    path: row?.path ?? null,
    scheduleMinutes: row?.scheduleMinutes ?? null,
    lastSyncAt: row?.lastSyncAt ?? null,
    lastResult: (row?.lastResult as MemoryFolderRunResult | null | undefined) ?? null,
  };
}

export function memoryFolderService(db: Db, depsOverride?: Partial<MemoryFolderDeps>) {
  const deps: MemoryFolderDeps = {
    memories: depsOverride?.memories ?? memoryService(db),
    agents: depsOverride?.agents ?? agentService(db),
    companyName:
      depsOverride?.companyName ??
      (async (companyId: string) => {
        const rows = await db
          .select({ name: companies.name })
          .from(companies)
          .where(eq(companies.id, companyId));
        return rows[0]?.name ?? "Company";
      }),
    now: depsOverride?.now,
  };

  async function getRow(companyId: string): Promise<FolderRow | null> {
    const rows = await db.select().from(memoryFolders).where(eq(memoryFolders.companyId, companyId));
    return rows[0] ?? null;
  }

  async function recordResult(companyId: string, result: MemoryFolderRunResult) {
    await db
      .update(memoryFolders)
      .set({
        lastSyncAt: new Date(result.finishedAt),
        lastResult: result as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(eq(memoryFolders.companyId, companyId));
  }

  async function run(companyId: string, mode: MemoryFolderMode, trigger: MemoryFolderTrigger) {
    const row = await getRow(companyId);
    if (!row) throw unprocessable("No memory folder is configured for this company");
    const result = await runMemoryFolder(deps, companyId, row.path, mode, trigger);
    await recordResult(companyId, result);
    return result;
  }

  return {
    getSettings: async (companyId: string) => toSettings(companyId, await getRow(companyId)),

    updateSettings: async (companyId: string, input: UpdateMemoryFolder) => {
      if (input.path.trim() === "") {
        await db.delete(memoryFolders).where(eq(memoryFolders.companyId, companyId));
        return toSettings(companyId, null);
      }
      const folder = normalizeFolderPath(input.path);
      const scheduleMinutes = input.scheduleMinutes ?? null;
      const rows = await db
        .insert(memoryFolders)
        .values({ companyId, path: folder, scheduleMinutes })
        .onConflictDoUpdate({
          target: memoryFolders.companyId,
          set: { path: folder, scheduleMinutes, updatedAt: sql`now()` },
        })
        .returning();
      return toSettings(companyId, rows[0]);
    },

    export: (companyId: string) => run(companyId, "export", "manual"),
    import: (companyId: string) => run(companyId, "import", "manual"),
    sync: (companyId: string) => run(companyId, "sync", "manual"),

    /** Run a scheduled sync for every company whose interval has elapsed. */
    tickDue: async (now: Date = new Date()) => {
      const rows = await db
        .select()
        .from(memoryFolders)
        .where(and(isNotNull(memoryFolders.scheduleMinutes), isNotNull(memoryFolders.path)));
      let ran = 0;
      let failed = 0;
      for (const row of rows) {
        const intervalMs = (row.scheduleMinutes ?? 0) * 60_000;
        if (intervalMs <= 0) continue;
        const last = row.lastSyncAt ? new Date(row.lastSyncAt).getTime() : 0;
        if (now.getTime() - last < intervalMs) continue;
        const result = await runMemoryFolder(deps, row.companyId, row.path, "sync", "scheduled");
        await recordResult(row.companyId, result);
        ran += 1;
        if (result.error) failed += 1;
      }
      return { ran, failed };
    },
  };
}

export type MemoryFolderService = ReturnType<typeof memoryFolderService>;
