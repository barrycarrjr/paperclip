// Browser-safe defaults for newly created local agents. Saved values are never rewritten.
export const AGENT_DEFAULT_TIMEOUT_SEC = 300;
export const AGENT_DEFAULT_MAX_TURNS_PER_RUN = 100;
export const CHAT_MAX_TOOL_LOOPS = 12;

const LOCAL_ADAPTER_TYPES = new Set([
  "process", "claude_local", "codex_local", "cursor", "cursor_local",
  "gemini_local", "grok_local", "kimi_local", "opencode_local", "pi_local",
  "aider_local", "ollama_local",
]);

export function applyNewAgentRunDefaults(
  adapterType: string | null | undefined,
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (!adapterType || !LOCAL_ADAPTER_TYPES.has(adapterType)) return { ...config };
  return {
    ...config,
    timeoutSec: config.timeoutSec === undefined ? AGENT_DEFAULT_TIMEOUT_SEC : config.timeoutSec,
    maxTurnsPerRun: config.maxTurnsPerRun === undefined ? AGENT_DEFAULT_MAX_TURNS_PER_RUN : config.maxTurnsPerRun,
  };
}
