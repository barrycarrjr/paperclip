/**
 * Operator control over who may run each plugin operation.
 *
 * A plugin's manifest says who an operation is FOR. That is the author's
 * judgement about the operation, and it is usually right, but it cannot know
 * anything about the install: which company this is, how much an agent is
 * trusted here, whether "send an invoice" is something anyone is comfortable
 * letting an unattended agent do at all.
 *
 * This is where the operator says so. Three controls per operation:
 *
 * - turn it off entirely
 * - narrow who may run it
 * - require a human to approve before an agent runs it
 *
 * **The override can only narrow.** A manifest that publishes an operation to
 * users only cannot be turned into an agent tool by configuration. That
 * direction matters: it means installing a plugin never gives agents reach the
 * author did not publish to them, so reviewing a manifest is enough to know
 * the ceiling.
 *
 * @see PLUGIN_SPEC.md §11.8 — Operator control over operations
 */

import type { PluginOperationAudience } from "./constants.js";

/** What an operator has said about one operation. */
export interface PluginOperationPolicyEntry {
  /**
   * Narrower audience than the manifest declares. A value that would widen it
   * is ignored, not rejected — an operator who has narrowed an operation and
   * then upgrades to a plugin version that narrows it further should end up
   * with the narrower of the two, not an error at load time.
   */
  audience?: PluginOperationAudience;
  /**
   * Make an agent get a human yes before this runs. No effect on the user
   * lane: a person triggering it IS the human approval.
   */
  requiresApproval?: boolean;
  /** Nobody may run it, by either lane. */
  disabled?: boolean;
}

/** Operator overrides for a whole plugin, keyed by operation key. */
export type PluginOperationPolicy = Record<string, PluginOperationPolicyEntry>;

/** The settled answer for one operation, after the override is applied. */
export interface ResolvedOperationPolicy {
  /** Who may actually run it. `"none"` when it is switched off. */
  audience: PluginOperationAudience | "none";
  /** Whether an agent needs a human yes first. */
  requiresApproval: boolean;
  /** Whether the operator switched it off. */
  disabled: boolean;
  /** True when the operator asked for something wider than the manifest allows. */
  overrideIgnored: boolean;
}

/** Which lanes each audience covers, so "narrower" is a set question. */
const LANES: Record<PluginOperationAudience, ReadonlySet<"agents" | "users">> = {
  both: new Set(["agents", "users"] as const),
  agents: new Set(["agents"] as const),
  users: new Set(["users"] as const),
};

/**
 * Apply an operator override to a declared audience, narrowing only.
 *
 * An override is honoured when its lanes are a subset of the declared lanes.
 * Anything else is ignored and flagged, so the caller can tell the operator
 * their setting is not doing what they think rather than silently obeying or
 * silently dropping it.
 */
export function resolveOperationPolicy(
  declared: PluginOperationAudience | undefined,
  override: PluginOperationPolicyEntry | undefined,
): ResolvedOperationPolicy {
  const declaredAudience = declared ?? "both";

  if (override?.disabled) {
    return { audience: "none", requiresApproval: false, disabled: true, overrideIgnored: false };
  }

  const requiresApproval = override?.requiresApproval === true;

  if (!override?.audience || override.audience === declaredAudience) {
    return {
      audience: declaredAudience,
      requiresApproval,
      disabled: false,
      overrideIgnored: false,
    };
  }

  const declaredLanes = LANES[declaredAudience];
  const requestedLanes = LANES[override.audience];
  const narrows = [...requestedLanes].every((lane) => declaredLanes.has(lane));

  return {
    audience: narrows ? override.audience : declaredAudience,
    requiresApproval,
    disabled: false,
    overrideIgnored: !narrows,
  };
}

/** Whether agents may run an operation with this resolved policy. */
export function policyAllowsAgents(policy: ResolvedOperationPolicy): boolean {
  return policy.audience === "both" || policy.audience === "agents";
}

/** Whether people may run an operation with this resolved policy. */
export function policyAllowsUsers(policy: ResolvedOperationPolicy): boolean {
  return policy.audience === "both" || policy.audience === "users";
}
