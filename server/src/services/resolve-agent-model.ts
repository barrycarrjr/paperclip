import type { InstanceAgentDefaults } from "@paperclipai/shared";

/**
 * Decide what `model` value should flow into the adapter spawn for a given
 * agent. If the agent's adapterConfig already specifies a non-empty model,
 * that wins. Otherwise we fill in the instance default for the agent's
 * adapter type. If neither is set we leave the field empty and the adapter
 * CLI picks its own default — preserving the pre-feature behavior for
 * un-configured installs.
 *
 * Note: the claude-local adapter silently ignores `--model X` when auth is
 * Bedrock and X is an Anthropic-style ID. That fallthrough still works here:
 * we substitute the configured default into config.model, and the adapter's
 * existing Bedrock guard at packages/adapters/claude-local/src/server/execute.ts
 * skips the flag. Bedrock users who care should set the model explicitly per
 * agent.
 */
export function resolveAgentModelForRun(input: {
  adapterType: string;
  configuredModel: unknown;
  instanceAgentDefaults: InstanceAgentDefaults;
}): string {
  const explicit = readNonEmptyString(input.configuredModel);
  if (explicit !== null) return explicit;
  const fallback = input.instanceAgentDefaults.defaultModelByAdapterType[input.adapterType];
  if (typeof fallback === "string" && fallback.trim().length > 0) return fallback.trim();
  return "";
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
