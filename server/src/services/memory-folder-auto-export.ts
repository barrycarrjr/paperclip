import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { memoryFolderService, type MemoryFolderService } from "./memory-folder-sync.js";

/**
 * Keeps a company's memory folder current after every save or delete in
 * Paperclip. Called fire-and-forget from the memory routes and Clippy's
 * remember/forget tools; it does nothing when no folder is configured.
 *
 * Writes are debounced per company so a burst of edits produces one export.
 */

const DEBOUNCE_MS = 1500;

const pending = new Map<string, NodeJS.Timeout>();
let serviceFactory: (db: Db) => Pick<MemoryFolderService, "getSettings" | "export"> = (db) =>
  memoryFolderService(db);

/** Test hook: swap the service used by the auto-export. */
export function setMemoryFolderAutoExportServiceFactory(
  factory: ((db: Db) => Pick<MemoryFolderService, "getSettings" | "export">) | null,
) {
  serviceFactory = factory ?? ((db) => memoryFolderService(db));
}

export function scheduleMemoryFolderExport(db: Db, companyId: string, delayMs = DEBOUNCE_MS): void {
  const existing = pending.get(companyId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pending.delete(companyId);
    void runMemoryFolderExportNow(db, companyId);
  }, delayMs);
  // Never keep the process alive just for a pending export.
  timer.unref?.();
  pending.set(companyId, timer);
}

export async function runMemoryFolderExportNow(db: Db, companyId: string): Promise<boolean> {
  try {
    const service = serviceFactory(db);
    const settings = await service.getSettings(companyId);
    if (!settings.path) return false;
    const result = await service.export(companyId);
    if (result.error) {
      logger.warn({ companyId, error: result.error }, "memory folder auto-export failed");
    }
    return true;
  } catch (err) {
    logger.warn({ err, companyId }, "memory folder auto-export failed");
    return false;
  }
}

/** Test hook: cancel anything queued. */
export function clearPendingMemoryFolderExports(): void {
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
}
