export type AgentSkillSyncMode = "unsupported" | "persistent" | "ephemeral";

export type AgentSkillAssignmentMode = "add" | "remove" | "replace";

export type AgentSkillState =
  | "available"
  | "configured"
  | "installed"
  | "missing"
  | "sync_failed"
  | "stale"
  | "external";

export type AgentSkillOrigin =
  | "company_managed"
  | "paperclip_required"
  | "user_installed"
  | "external_unknown";

export interface AgentDesiredSkillEntry {
  key: string;
  versionId: string | null;
}

export interface AgentSkillEntry {
  key: string;
  runtimeName: string | null;
  versionId?: string | null;
  currentVersionId?: string | null;
  desired: boolean;
  managed: boolean;
  required?: boolean;
  requiredReason?: string | null;
  state: AgentSkillState;
  origin?: AgentSkillOrigin;
  originLabel?: string | null;
  originBadge?: string | null;
  locationLabel?: string | null;
  readOnly?: boolean;
  sourcePath?: string | null;
  targetPath?: string | null;
  detail?: string | null;
  source?: string | null;
  sourceStatus?: string | null;
  sourceKind?: string | null;
  missingDetail?: string | null;
  configError?: string | null;
}

export interface AgentSkillSnapshot {
  supported: boolean;
  mode: AgentSkillSyncMode;
  adapterType?: string | null;
  desiredSkills: string[];
  desiredSkillEntries?: AgentDesiredSkillEntry[];
  entries: AgentSkillEntry[];
  warnings: string[];
}

export interface AgentSkillSyncRequest {
  mode?: AgentSkillAssignmentMode;
  desiredSkills: Array<string | AgentDesiredSkillEntry>;
}
