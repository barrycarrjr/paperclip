export const DAILY_RETENTION_PRESETS = [3, 7, 14] as const;
export const WEEKLY_RETENTION_PRESETS = [1, 2, 4] as const;
export const MONTHLY_RETENTION_PRESETS = [1, 3, 6] as const;
export const DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS = 24;
export const MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS = 1;
export const MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS = 24 * 30;

export interface BackupRetentionPolicy {
  dailyDays: (typeof DAILY_RETENTION_PRESETS)[number];
  weeklyWeeks: (typeof WEEKLY_RETENTION_PRESETS)[number];
  monthlyMonths: (typeof MONTHLY_RETENTION_PRESETS)[number];
}

export const DEFAULT_BACKUP_RETENTION: BackupRetentionPolicy = {
  dailyDays: 7,
  weeklyWeeks: 4,
  monthlyMonths: 1,
};

/**
 * Addresses that identify the operator themselves across outbound channels.
 * The tool draft gate treats a gated outbound call whose every recipient is
 * one of these addresses as a self-notification and lets it send without an
 * approval (when `skipApproval` is on). Matching is conservative: any
 * recipient that cannot be positively identified as the operator keeps the
 * call in the approval queue.
 */
export interface SelfNotifySettings {
  /** Master switch for the self-notification bypass. Default true. */
  skipApproval: boolean;
  /** U-prefixed Slack user IDs that are the operator (case-insensitive match). */
  slackUserIds: string[];
  /** The operator's email addresses (case-insensitive; display-name forms accepted). */
  emails: string[];
  /** The operator's phone numbers (compared digits-only, so formatting doesn't matter). */
  phoneNumbers: string[];
}

export const DEFAULT_SELF_NOTIFY_SETTINGS: SelfNotifySettings = {
  skipApproval: true,
  slackUserIds: [],
  emails: [],
  phoneNumbers: [],
};

export interface InstanceGeneralSettings {
  censorUsernameInLogs: boolean;
  keyboardShortcuts: boolean;
  backupRetention: BackupRetentionPolicy;
  /**
   * When true (the default), agent calls to outbound messaging tools listed in
   * OUTBOUND_TOOL_DRAFT_GATE are held as pending approvals instead of sending
   * immediately. Turning this off disables the review step for ALL outbound
   * messages, including ones addressed to other people.
   */
  outboundToolDraftMode: boolean;
  selfNotify: SelfNotifySettings;
}

export interface InstanceExperimentalSettings {
  enableEnvironments: boolean;
  enableIsolatedWorkspaces: boolean;
  autoRestartDevServerWhenIdle: boolean;
  enableIssueGraphLivenessAutoRecovery: boolean;
  issueGraphLivenessAutoRecoveryLookbackHours: number;
}

export interface InstanceAgentDefaults {
  defaultModelByAdapterType: Record<string, string>;
}

export interface InstanceSettings {
  id: string;
  general: InstanceGeneralSettings;
  experimental: InstanceExperimentalSettings;
  agentDefaults: InstanceAgentDefaults;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueGraphLivenessAutoRecoveryPreviewItem {
  issueId: string;
  identifier: string | null;
  title: string;
  state: string;
  severity: string;
  reason: string;
  recoveryIssueId: string;
  recoveryIdentifier: string | null;
  recoveryTitle: string | null;
  recommendedOwnerAgentId: string | null;
  incidentKey: string;
  latestDependencyUpdatedAt: string;
  dependencyPath: Array<{
    issueId: string;
    identifier: string | null;
    title: string;
    status: string;
  }>;
}

export interface IssueGraphLivenessAutoRecoveryPreview {
  lookbackHours: number;
  cutoff: string;
  generatedAt: string;
  findings: number;
  recoverableFindings: number;
  skippedOutsideLookback: number;
  items: IssueGraphLivenessAutoRecoveryPreviewItem[];
}
