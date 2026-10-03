export interface MemoryFolderRunResult {
  /** "export", "import" or "sync" (import then export). */
  mode: "export" | "import" | "sync";
  trigger: "manual" | "scheduled";
  startedAt: string;
  finishedAt: string;
  exported: number;
  removed: number;
  created: number;
  updated: number;
  skipped: number;
  /** Human-readable notes about files that were skipped or needed attention. */
  warnings: string[];
  error: string | null;
}

export interface MemoryFolderSettings {
  companyId: string;
  path: string | null;
  scheduleMinutes: number | null;
  lastSyncAt: Date | string | null;
  lastResult: MemoryFolderRunResult | null;
}
