import { actionApprovalModesSchema, type ActionApprovalModes } from "@paperclipai/shared";

export type NormalizedAgentPermissions = Record<string, unknown> & {
  canCreateAgents: boolean;
  actionApprovalModes?: ActionApprovalModes;
};

export function defaultPermissionsForRole(role: string): NormalizedAgentPermissions {
  return {
    canCreateAgents: role === "ceo",
  };
}

export function normalizeAgentPermissions(
  permissions: unknown,
  role: string,
): NormalizedAgentPermissions {
  const defaults = defaultPermissionsForRole(role);
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
    return defaults;
  }

  const record = permissions as Record<string, unknown>;
  const actionApprovalModes = actionApprovalModesSchema.safeParse(record.actionApprovalModes);
  const { actionApprovalModes: _storedActionApprovalModes, ...storedPermissions } = record;
  return {
    ...storedPermissions,
    canCreateAgents:
      typeof record.canCreateAgents === "boolean"
        ? record.canCreateAgents
        : defaults.canCreateAgents,
    ...(actionApprovalModes.success ? { actionApprovalModes: actionApprovalModes.data } : {}),
  };
}
