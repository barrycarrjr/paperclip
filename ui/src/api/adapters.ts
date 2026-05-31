/**
 * @fileoverview Frontend API client for external adapter management.
 */

import { api } from "./client";

export interface AdapterCapabilities {
  supportsInstructionsBundle: boolean;
  supportsSkills: boolean;
  supportsLocalAgentJwt: boolean;
  requiresMaterializedRuntimeSkills: boolean;
}

export interface AdapterInfo {
  type: string;
  label: string;
  /** Short one-liner describing what the adapter does, shown on the Adapters page. */
  description?: string;
  source: "builtin" | "external";
  modelsCount: number;
  loaded: boolean;
  disabled: boolean;
  capabilities: AdapterCapabilities;
  /** Installed version (for external npm adapters) */
  version?: string;
  /** Package name (for external adapters) */
  packageName?: string;
  /** Whether the adapter was installed from a local path (vs npm). */
  isLocalPath?: boolean;
  /** True when an external plugin has replaced a built-in adapter of the same type. */
  overriddenBuiltin?: boolean;
  /** True when the external override for a builtin type is currently paused. */
  overridePaused?: boolean;
}

export interface AdapterInstallResult {
  type: string;
  packageName: string;
  version?: string;
  installedAt: string;
}

export interface AdapterAuthStatus {
  loggedIn: boolean;
  method?: string | null;
  detail?: string | null;
}

export interface AdapterAuthResult {
  ok: boolean;
  loginUrl?: string | null;
  output?: string;
  error?: string;
}

export interface AdapterAuthStatusEntry {
  supported: boolean;
  status: AdapterAuthStatus | null;
}

export const adaptersApi = {
  /** List all registered adapters (built-in + external). */
  list: () => api.get<AdapterInfo[]>("/adapters"),

  /** Install an external adapter from npm or a local path. */
  install: (params: { packageName: string; version?: string; isLocalPath?: boolean }) =>
    api.post<AdapterInstallResult>("/adapters/install", params),

  /** Remove an external adapter by type. */
  remove: (type: string) => api.delete<{ type: string; removed: boolean }>(`/adapters/${type}`),

  /** Enable or disable an adapter (disabled adapters hidden from agent menus). */
  setDisabled: (type: string, disabled: boolean) =>
    api.patch<{ type: string; disabled: boolean; changed: boolean }>(`/adapters/${type}`, { disabled }),

  /** Pause or resume an external override of a builtin type. */
  setOverridePaused: (type: string, paused: boolean) =>
    api.patch<{ type: string; paused: boolean; changed: boolean }>(`/adapters/${type}/override`, { paused }),

  /** Reload an external adapter (bust server + client caches). */
  reload: (type: string) =>
    api.post<{ type: string; version?: string; reloaded: boolean }>(`/adapters/${type}/reload`, {}),

  /** Reinstall an npm-sourced adapter (pulls latest from registry, then reloads). */
  reinstall: (type: string) =>
    api.post<{ type: string; version?: string; reinstalled: boolean }>(`/adapters/${type}/reinstall`, {}),

  /** Batch query: per-adapter auth status (built-ins + external). */
  getAuthStatuses: () =>
    api.get<{ statuses: Record<string, AdapterAuthStatusEntry> }>("/adapters/auth-statuses"),

  /**
   * Start an interactive re-auth flow for an adapter (e.g. `claude setup-token`).
   * Returns a jobId immediately — the sign-in runs in the background (it opens a
   * browser and can take 1-2 minutes); poll {@link getAuthJob} for completion.
   */
  authenticate: (type: string) =>
    api.post<{ jobId: string; status: "running"; supported: boolean }>(`/adapters/${type}/authenticate`, {}),

  /** Poll the status of a background adapter sign-in started by {@link authenticate}. */
  getAuthJob: (jobId: string) =>
    api.get<{ status: "running" | "ok" | "error"; result: AdapterAuthResult | null; error: string | null }>(
      `/adapter-auth-jobs/${jobId}`,
    ),

  /**
   * Apply a long-lived token (pasted from `claude setup-token`, run in a
   * terminal) host-wide. claude_local only — reliable alternative to the
   * spawned interactive sign-in.
   */
  submitToken: (type: string, token: string) =>
    api.post<{ ok: boolean; expiresAt: string | null }>(`/adapters/${type}/submit-token`, { token }),
};
