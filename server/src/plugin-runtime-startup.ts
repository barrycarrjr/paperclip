// Whether this server process starts plugins: their workers, the plugin job
// scheduler, and the coordinator that keeps jobs in step with plugin state.
//
// PAPERCLIP_PLUGIN_RUNTIME_ENABLED=false turns all of that off. The safe
// update (scripts/launchers/update-guard.mjs) sets it on the trial start of a
// new version, together with HEARTBEAT_SCHEDULER_ENABLED=false, because the
// trial server is stopped seconds after it answers /api/health. Without it, a
// plugin job that fell due while the update was running would fire on the
// first scheduler tick, a plugin could wake an agent, and a chat plugin such
// as Slack would start answering messages, all to be cut off part way.
// Plugin routes stay mounted; only the start-up of the plugins themselves is
// skipped.
//
// The warm-up of external MCP servers goes with them. Their tools reach Clippy
// and agents through the same dispatcher as plugin tools, and warming one
// starts a child process (for Docker's MCP gateway, a container per enabled
// server) that a trial would only kill again.

export const PLUGIN_RUNTIME_ENV = "PAPERCLIP_PLUGIN_RUNTIME_ENABLED";

export function pluginRuntimeEnabledFromEnv(env: Record<string, string | undefined>): boolean {
  return env[PLUGIN_RUNTIME_ENV] !== "false";
}

export interface PluginRuntimeStartSteps {
  startJobCoordinator(): void;
  startScheduler(): void;
  loadPlugins(): void;
  // Must return at once and never throw: start-up does not wait for a server
  // to connect, and one that cannot start must not stop Paperclip starting.
  warmExternalMcpServers(): void;
  onSkipped?(): void;
}

// Runs the start steps when enabled. Returns whether they ran.
export function startPluginRuntime(enabled: boolean, steps: PluginRuntimeStartSteps): boolean {
  if (!enabled) {
    steps.onSkipped?.();
    return false;
  }
  steps.startJobCoordinator();
  steps.startScheduler();
  steps.loadPlugins();
  steps.warmExternalMcpServers();
  return true;
}
