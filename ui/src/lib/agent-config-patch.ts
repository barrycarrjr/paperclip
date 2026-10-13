import type { Agent, AgentModelSelection } from "@paperclipai/shared";

export interface AgentConfigOverlay {
  identity: Record<string, unknown>;
  adapterType?: string;
  adapterConfig: Record<string, unknown>;
  heartbeat: Record<string, unknown>;
  /** The whole automatic model selection setting, when edited. */
  modelSelection?: AgentModelSelection;
  runtime: Record<string, unknown>;
}

const ADAPTER_AGNOSTIC_KEYS = [
  "env",
  "promptTemplate",
  "instructionsFilePath",
  "cwd",
  "timeoutSec",
  "graceSec",
  "bootstrapPromptTemplate",
] as const;

function omitUndefinedEntries(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  );
}

export function buildAgentUpdatePatch(agent: Agent, overlay: AgentConfigOverlay) {
  const patch: Record<string, unknown> = {};

  if (Object.keys(overlay.identity).length > 0) {
    Object.assign(patch, overlay.identity);
  }

  if (overlay.adapterType !== undefined) {
    patch.adapterType = overlay.adapterType;
  }

  if (overlay.adapterType !== undefined || Object.keys(overlay.adapterConfig).length > 0) {
    const existing = (agent.adapterConfig ?? {}) as Record<string, unknown>;
    const nextAdapterConfig =
      overlay.adapterType !== undefined
        ? {
            ...Object.fromEntries(
              ADAPTER_AGNOSTIC_KEYS
                .filter((key) => existing[key] !== undefined)
                .map((key) => [key, existing[key]]),
            ),
            ...overlay.adapterConfig,
          }
        : {
            ...existing,
            ...overlay.adapterConfig,
          };

    patch.adapterConfig = omitUndefinedEntries(nextAdapterConfig);
    patch.replaceAdapterConfig = true;
  }

  if (Object.keys(overlay.heartbeat).length > 0 || overlay.modelSelection !== undefined) {
    const existingRc = (agent.runtimeConfig ?? {}) as Record<string, unknown>;
    const nextRc: Record<string, unknown> = { ...existingRc };
    if (Object.keys(overlay.heartbeat).length > 0) {
      const existingHb = (existingRc.heartbeat ?? {}) as Record<string, unknown>;
      nextRc.heartbeat = { ...existingHb, ...overlay.heartbeat };
    }
    if (overlay.modelSelection !== undefined) {
      nextRc.modelSelection = overlay.modelSelection;
    }
    patch.runtimeConfig = nextRc;
  }

  if (Object.keys(overlay.runtime).length > 0) {
    Object.assign(patch, overlay.runtime);
  }

  return patch;
}
