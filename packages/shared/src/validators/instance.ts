import { z } from "zod";
import {
  DAILY_RETENTION_PRESETS,
  WEEKLY_RETENTION_PRESETS,
  MONTHLY_RETENTION_PRESETS,
  DEFAULT_BACKUP_RETENTION,
  DEFAULT_EMAIL_HANDOFF_REPLY_APPROVAL,
  DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  DEFAULT_SELF_NOTIFY_SETTINGS,
  EMAIL_HANDOFF_REPLY_APPROVAL_VALUES,
  MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
} from "../types/instance.js";
import {
  patchSkipPermissionsByAdapterTypeSchema,
  skipPermissionsByAdapterTypeSchema,
} from "../agent-permission-defaults.js";

function presetSchema<T extends readonly number[]>(presets: T, label: string) {
  return z.number().refine(
    (v): v is T[number] => (presets as readonly number[]).includes(v),
    { message: `${label} must be one of: ${presets.join(", ")}` },
  );
}

export const backupRetentionPolicySchema = z.object({
  dailyDays: presetSchema(DAILY_RETENTION_PRESETS, "dailyDays").default(DEFAULT_BACKUP_RETENTION.dailyDays),
  weeklyWeeks: presetSchema(WEEKLY_RETENTION_PRESETS, "weeklyWeeks").default(DEFAULT_BACKUP_RETENTION.weeklyWeeks),
  monthlyMonths: presetSchema(MONTHLY_RETENTION_PRESETS, "monthlyMonths").default(DEFAULT_BACKUP_RETENTION.monthlyMonths),
});

export const selfNotifySettingsSchema = z.object({
  skipApproval: z.boolean().default(true),
  slackUserIds: z.array(z.string().trim().min(1)).default([]),
  emails: z.array(z.string().trim().min(1)).default([]),
  phoneNumbers: z.array(z.string().trim().min(1)).default([]),
}).strict();

export const instanceGeneralSettingsSchema = z.object({
  censorUsernameInLogs: z.boolean().default(false),
  keyboardShortcuts: z.boolean().default(false),
  backupRetention: backupRetentionPolicySchema.default(DEFAULT_BACKUP_RETENTION),
  outboundToolDraftMode: z.boolean().default(true),
  emailHandoffReplyApproval: z
    .enum(EMAIL_HANDOFF_REPLY_APPROVAL_VALUES)
    .default(DEFAULT_EMAIL_HANDOFF_REPLY_APPROVAL),
  selfNotify: selfNotifySettingsSchema.default(DEFAULT_SELF_NOTIFY_SETTINGS),
}).strict();

export const patchInstanceGeneralSettingsSchema = instanceGeneralSettingsSchema.partial();

export const instanceExperimentalSettingsSchema = z.object({
  enableEnvironments: z.boolean().default(false),
  enableNativeRunner: z.boolean().default(true),
  enableManagedSandboxOnly: z.boolean().default(false),
  enableIsolatedWorkspaces: z.boolean().default(false),
  enableIsolatedWorkspacesByDefault: z.boolean().default(false),
  enableStreamlinedLeftNavigation: z.boolean().default(true),
  enableStreamlinedUi: z.boolean().default(true),
  enableApps: z.boolean().default(true),
  enableChatConnectors: z.boolean().default(false),
  enableMcpAggregators: z.boolean().default(true),
  enableMemoryConnectors: z.boolean().default(false),
  enablePipelines: z.boolean().default(true),
  enableCases: z.boolean().default(true),
  enableAgentChat: z.boolean().default(false),
  enableConferenceRoomChat: z.boolean().default(false),
  enableClassicTaskInterface: z.boolean().default(false),
  enableIssuePlanDecompositions: z.boolean().default(false),
  enableExperimentalFileViewer: z.boolean().default(false),
  enableExternalObjects: z.boolean().default(false),
  enableSmokeLab: z.boolean().default(false),
  enableBuiltInAgents: z.boolean().default(false),
  enableBetaSkills: z.boolean().default(false),
  enableSummaries: z.boolean().default(false),
  enableStatusCards: z.boolean().default(false),
  enableDecisions: z.boolean().default(false),
  enableGoalsSidebarLink: z.boolean().default(false),
  enableServerInfoDebugView: z.boolean().default(false),
  enablePaperclipDeveloperMode: z.boolean().default(false),
  enableSimplifiedEnglishInteractions: z.boolean().default(false),
  enableFirstTaskPlanProposal: z.boolean().default(false),
  autoRestartDevServerWhenIdle: z.boolean().default(false),
  enableWorkspaceBranchReconcileForward: z.boolean().default(true),
  enableWorkspaceDirtyQuarantineRepair: z.boolean().default(true),
  enableOwnerInstanceAdmin: z.boolean().default(false),
  enableSandboxDuplexBridge: z.boolean().default(false),
  enableRunnerPreviewIngress: z.boolean().default(false),
  enableWorktreeRunExecution: z.boolean().default(false),
  worktreeRunExecutionActivatedAt: z.string().datetime().nullable().default(null),
  worktreeRunExecutionActivationInstanceId: z.string().min(1).nullable().default(null),
  enableIssueGraphLivenessAutoRecovery: z.boolean().default(false),
  issueGraphLivenessAutoRecoveryLookbackHours: z
    .number()
    .int()
    .min(MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS)
    .max(MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS)
    .default(DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS),
}).strict();

export const patchInstanceExperimentalSettingsSchema = instanceExperimentalSettingsSchema.partial();

export const instanceAgentDefaultsSchema = z.object({
  defaultModelByAdapterType: z.record(z.string().min(1), z.string()).default({}),
  skipPermissionsByAdapterType: skipPermissionsByAdapterTypeSchema.default({}),
}).strict();

export const patchInstanceAgentDefaultsSchema = z.object({
  defaultModelByAdapterType: z.record(z.string().min(1), z.string()).optional(),
  /** `null` for an adapter type clears that default. */
  skipPermissionsByAdapterType: patchSkipPermissionsByAdapterTypeSchema.optional(),
}).strict();

export const issueGraphLivenessAutoRecoveryRequestSchema = z.object({
  lookbackHours: z
    .number()
    .int()
    .min(MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS)
    .max(MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS)
    .optional(),
}).strict();

export type InstanceGeneralSettings = z.infer<typeof instanceGeneralSettingsSchema>;
export type PatchInstanceGeneralSettings = z.infer<typeof patchInstanceGeneralSettingsSchema>;
export type InstanceExperimentalSettings = z.infer<typeof instanceExperimentalSettingsSchema>;
export type PatchInstanceExperimentalSettings = z.infer<typeof patchInstanceExperimentalSettingsSchema>;
export type InstanceAgentDefaults = z.infer<typeof instanceAgentDefaultsSchema>;
export type PatchInstanceAgentDefaults = z.infer<typeof patchInstanceAgentDefaultsSchema>;
export type IssueGraphLivenessAutoRecoveryRequest = z.infer<
  typeof issueGraphLivenessAutoRecoveryRequestSchema
>;
