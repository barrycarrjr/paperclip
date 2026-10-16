import { z } from "zod";
import {
  AGENT_ACTION_MODES,
  AGENT_ACTION_TYPES,
  type AgentActionMode,
  type AgentActionType,
} from "./constants.js";

/**
 * Run-permission defaults ("skip permission prompts") for local adapters.
 *
 * Each supported adapter stores the setting under its own adapterConfig key.
 * An agent that has no boolean stored under that key inherits, in order: the
 * company default, then the instance default, then the code default below.
 */
export const AGENT_PERMISSION_DEFAULT_ADAPTER_TYPES = [
  "claude_local",
  "codex_local",
  "opencode_local",
] as const;

export type AgentPermissionDefaultAdapterType = (typeof AGENT_PERMISSION_DEFAULT_ADAPTER_TYPES)[number];

/** The adapterConfig key each adapter reads. */
export const AGENT_PERMISSION_CONFIG_KEY: Record<AgentPermissionDefaultAdapterType, string> = {
  claude_local: "dangerouslySkipPermissions",
  codex_local: "dangerouslyBypassApprovalsAndSandbox",
  opencode_local: "dangerouslySkipPermissions",
};

/**
 * Older keys that still count as "set on this agent". Codex agents saved
 * before the rename store `dangerouslyBypassSandbox`, which the adapter
 * still honours.
 */
export const AGENT_PERMISSION_LEGACY_CONFIG_KEYS: Partial<Record<AgentPermissionDefaultAdapterType, string[]>> = {
  codex_local: ["dangerouslyBypassSandbox"],
};

/** What each adapter did before any default could be configured. */
export const AGENT_PERMISSION_CODE_DEFAULT: Record<AgentPermissionDefaultAdapterType, boolean> = {
  claude_local: true,
  codex_local: true,
  opencode_local: true,
};

export type AgentPermissionSource = "agent" | "company" | "instance" | "code";

export type SkipPermissionsByAdapterType = Partial<Record<AgentPermissionDefaultAdapterType, boolean>>;
export type ActionApprovalModes = Partial<Record<AgentActionType, AgentActionMode>>;

export const agentPermissionDefaultAdapterTypeSchema = z.enum(AGENT_PERMISSION_DEFAULT_ADAPTER_TYPES);

export const skipPermissionsByAdapterTypeSchema = z
  .object({
    claude_local: z.boolean().optional(),
    codex_local: z.boolean().optional(),
    opencode_local: z.boolean().optional(),
  })
  .strict();

/** In a patch, `null` clears the default for that adapter type. */
export const patchSkipPermissionsByAdapterTypeSchema = z
  .object({
    claude_local: z.boolean().nullable().optional(),
    codex_local: z.boolean().nullable().optional(),
    opencode_local: z.boolean().nullable().optional(),
  })
  .strict();

export const actionApprovalModesSchema = z
  .object({
    send_message: z.enum(AGENT_ACTION_MODES).optional(),
    move_money: z.enum(AGENT_ACTION_MODES).optional(),
    change_files: z.enum(AGENT_ACTION_MODES).optional(),
    post_publicly: z.enum(AGENT_ACTION_MODES).optional(),
    change_knowledge_base: z.enum(AGENT_ACTION_MODES).optional(),
  })
  .strict();

/** In a patch, `null` clears the default for that action type. */
export const patchActionApprovalModesSchema = z
  .object({
    send_message: z.enum(AGENT_ACTION_MODES).nullable().optional(),
    move_money: z.enum(AGENT_ACTION_MODES).nullable().optional(),
    change_files: z.enum(AGENT_ACTION_MODES).nullable().optional(),
    post_publicly: z.enum(AGENT_ACTION_MODES).nullable().optional(),
    change_knowledge_base: z.enum(AGENT_ACTION_MODES).nullable().optional(),
  })
  .strict();

export const companyAgentDefaultsSchema = z
  .object({
    skipPermissionsByAdapterType: skipPermissionsByAdapterTypeSchema.default({}),
    actionApprovalModes: actionApprovalModesSchema.default({}),
  })
  .strict();

export const patchCompanyAgentDefaultsSchema = z
  .object({
    skipPermissionsByAdapterType: patchSkipPermissionsByAdapterTypeSchema.optional(),
    actionApprovalModes: patchActionApprovalModesSchema.optional(),
  })
  .strict();

export interface CompanyAgentDefaults {
  skipPermissionsByAdapterType: SkipPermissionsByAdapterType;
  actionApprovalModes: ActionApprovalModes;
}

export type PatchCompanyAgentDefaults = z.infer<typeof patchCompanyAgentDefaultsSchema>;

export function isAgentPermissionDefaultAdapterType(
  adapterType: string | null | undefined,
): adapterType is AgentPermissionDefaultAdapterType {
  return (AGENT_PERMISSION_DEFAULT_ADAPTER_TYPES as readonly string[]).includes(adapterType ?? "");
}

/** The value stored on the agent itself, or null when it inherits. */
export function readAgentOwnSkipPermissions(
  adapterType: AgentPermissionDefaultAdapterType,
  adapterConfig: Record<string, unknown> | null | undefined,
): boolean | null {
  const config = adapterConfig ?? {};
  const keys = [AGENT_PERMISSION_CONFIG_KEY[adapterType], ...(AGENT_PERMISSION_LEGACY_CONFIG_KEYS[adapterType] ?? [])];
  for (const key of keys) {
    const value = config[key];
    if (typeof value === "boolean") return value;
  }
  return null;
}

export interface ResolvedAgentPermission {
  adapterType: AgentPermissionDefaultAdapterType;
  configKey: string;
  skipPermissions: boolean;
  source: AgentPermissionSource;
}

/**
 * Agent value if set, else company default, else instance default, else the
 * code default. Returns null for adapter types without this setting.
 */
export function resolveAgentSkipPermissions(input: {
  adapterType: string | null | undefined;
  adapterConfig: Record<string, unknown> | null | undefined;
  companyDefaults?: { skipPermissionsByAdapterType?: SkipPermissionsByAdapterType | null } | null;
  instanceDefaults?: { skipPermissionsByAdapterType?: SkipPermissionsByAdapterType | null } | null;
}): ResolvedAgentPermission | null {
  const { adapterType } = input;
  if (!isAgentPermissionDefaultAdapterType(adapterType)) return null;
  const configKey = AGENT_PERMISSION_CONFIG_KEY[adapterType];
  const own = readAgentOwnSkipPermissions(adapterType, input.adapterConfig);
  if (own !== null) return { adapterType, configKey, skipPermissions: own, source: "agent" };
  const companyValue = input.companyDefaults?.skipPermissionsByAdapterType?.[adapterType];
  if (typeof companyValue === "boolean") {
    return { adapterType, configKey, skipPermissions: companyValue, source: "company" };
  }
  const instanceValue = input.instanceDefaults?.skipPermissionsByAdapterType?.[adapterType];
  if (typeof instanceValue === "boolean") {
    return { adapterType, configKey, skipPermissions: instanceValue, source: "instance" };
  }
  return {
    adapterType,
    configKey,
    skipPermissions: AGENT_PERMISSION_CODE_DEFAULT[adapterType],
    source: "code",
  };
}

/** Apply a patch where `null` clears an adapter type's value. */
export function mergeSkipPermissionsByAdapterType(
  current: SkipPermissionsByAdapterType,
  patch: Partial<Record<AgentPermissionDefaultAdapterType, boolean | null | undefined>> | undefined,
): SkipPermissionsByAdapterType {
  const next: SkipPermissionsByAdapterType = { ...current };
  for (const adapterType of AGENT_PERMISSION_DEFAULT_ADAPTER_TYPES) {
    if (!patch || !Object.prototype.hasOwnProperty.call(patch, adapterType)) continue;
    const value = patch[adapterType];
    if (typeof value === "boolean") next[adapterType] = value;
    else delete next[adapterType];
  }
  return next;
}

/** Apply a patch where `null` clears an action type's value. */
export function mergeActionApprovalModes(
  current: ActionApprovalModes,
  patch: Partial<Record<AgentActionType, AgentActionMode | null | undefined>> | undefined,
): ActionApprovalModes {
  const next: ActionApprovalModes = { ...current };
  for (const actionType of AGENT_ACTION_TYPES) {
    if (!patch || !Object.prototype.hasOwnProperty.call(patch, actionType)) continue;
    const value = patch[actionType];
    if (value && (AGENT_ACTION_MODES as readonly string[]).includes(value)) next[actionType] = value;
    else delete next[actionType];
  }
  return next;
}
