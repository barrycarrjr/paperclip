export const KNOWLEDGE_BASE_FINDING_KINDS = [
  "malformed_frontmatter",
  "broken_relative_link",
  "invalid_drive_id",
  "orphan_note",
  "stale_active_note",
  "open_gap",
  "unsafe_entry",
  "missing_drive_id",
  "conflicting_drive_id",
  "duplicate_drive_id",
  "unresolved_drive_id",
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
  driveLinkMode: boolean;
  linkMigration: { planHash: string; status: "pending" | "completed" } | null;
  scheduleMinutes: number | null;
  lastSyncAt: Date | string | null;
  lastResult: MemoryFolderRunResult | null;
}

export interface DocumentLinkChange {
  path: string;
  line: number;
  target: string;
  replacement: string;
  driveFileId: string;
  evidence: "target_frontmatter" | "existing_identity";
}

export interface DocumentLinkPreview {
  planHash: string;
  memoriesChanged: number;
  changes: DocumentLinkChange[];
  skipped: Array<{ path: string; line: number | null; reason: string }>;
  before: KnowledgeBaseValidationResult;
  after: KnowledgeBaseValidationResult;
}

export interface DocumentLinkApplyResult {
  planHash: string;
  status: "pending" | "completed";
  filesChanged: number;
  memoriesChanged: number;
  before: KnowledgeBaseValidationResult;
  after: KnowledgeBaseValidationResult | null;
}
