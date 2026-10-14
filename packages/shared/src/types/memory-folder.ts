export const KNOWLEDGE_BASE_FINDING_KINDS = [
  "malformed_frontmatter",
  "broken_relative_link",
  "invalid_drive_id",
  "orphan_note",
  "stale_active_note",
  "open_gap",
  "unsafe_entry",
] as const;

export type KnowledgeBaseFindingKind = (typeof KNOWLEDGE_BASE_FINDING_KINDS)[number];

export interface KnowledgeBaseFinding {
  kind: KnowledgeBaseFindingKind;
  fingerprint: string;
  severity: "low" | "medium" | "high";
  /** Slash-separated path relative to the configured company folder. */
  path: string;
  line: number | null;
  summary: string;
  details: Record<string, unknown>;
}

export interface KnowledgeBaseValidationResult {
  trigger: "manual" | "scheduled";
  scannedAt: string;
  filesScanned: number;
  findings: KnowledgeBaseFinding[];
  error: string | null;
}

export interface KnowledgeBaseIndexResult {
  indexedAt: string;
  filesIndexed: number;
  changed: boolean;
}

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
  /** Read-only knowledge-base scan performed after the folder operation. */
  validation: KnowledgeBaseValidationResult | null;
  error: string | null;
}

export interface MemoryFolderSettings {
  companyId: string;
  path: string | null;
  scheduleMinutes: number | null;
  lastSyncAt: Date | string | null;
  lastResult: MemoryFolderRunResult | null;
}
