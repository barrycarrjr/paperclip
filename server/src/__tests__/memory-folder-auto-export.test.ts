import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  clearPendingMemoryFolderExports,
  runMemoryFolderExportNow,
  scheduleMemoryFolderExport,
  setMemoryFolderAutoExportServiceFactory,
} from "../services/memory-folder-auto-export.js";

const db = {} as unknown as Db;
const COMPANY_ID = "22222222-2222-2222-2222-222222222222";

function fakeService(configured: boolean) {
  const exportFn = vi.fn(async () => ({ error: null }) as never);
  setMemoryFolderAutoExportServiceFactory(() => ({
    getSettings: async (companyId: string) =>
      ({ companyId, path: configured ? "/tmp/x" : null, scheduleMinutes: null, lastSyncAt: null, lastResult: null }),
    export: exportFn,
  }));
  return exportFn;
}

afterEach(() => {
  clearPendingMemoryFolderExports();
  setMemoryFolderAutoExportServiceFactory(null);
  vi.useRealTimers();
});

describe("memory folder auto-export", () => {
  it("does nothing when the company has no folder configured", async () => {
    const exportFn = fakeService(false);
    expect(await runMemoryFolderExportNow(db, COMPANY_ID)).toBe(false);
    expect(exportFn).not.toHaveBeenCalled();
  });

  it("exports once for a burst of saves", async () => {
    vi.useFakeTimers();
    const exportFn = fakeService(true);
    scheduleMemoryFolderExport(db, COMPANY_ID, 100);
    scheduleMemoryFolderExport(db, COMPANY_ID, 100);
    scheduleMemoryFolderExport(db, COMPANY_ID, 100);
    await vi.advanceTimersByTimeAsync(150);
    expect(exportFn).toHaveBeenCalledTimes(1);
    expect(exportFn).toHaveBeenCalledWith(COMPANY_ID);
  });

  it("swallows a failing export so the save that triggered it still succeeds", async () => {
    setMemoryFolderAutoExportServiceFactory(() => ({
      getSettings: async () => {
        throw new Error("db down");
      },
      export: vi.fn(),
    }));
    expect(await runMemoryFolderExportNow(db, COMPANY_ID)).toBe(false);
  });
});
