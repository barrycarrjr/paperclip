import { api } from "./client";

export interface SystemActionResponse {
  ok: boolean;
  action: "shutdown" | "restart" | "update" | "rebuild";
  message?: string;
  usedLauncher?: boolean;
  error?: string;
}

export type SystemUpdateCheckErrorReason =
  | "no_install_marker"
  | "missing_remote"
  | "unsupported_remote"
  | "github_unreachable"
  | "github_error";

/**
 * Which gap is being reported. `remote_ahead` needs a pull, `build_behind`
 * needs a rebuild of what is already checked out.
 */
export type SystemUpdateCheckReason = "remote_ahead" | "build_behind";

export interface SystemUpdateCheck {
  available: boolean;
  /** What the checkout is on. */
  localCommit: string | null;
  /** What GitHub has on the tracked branch. */
  remoteCommit: string | null;
  /** What was last built and installed. */
  installedCommit: string | null;
  reason: SystemUpdateCheckReason | null;
  branch: string | null;
  lastChecked: string;
  error?: SystemUpdateCheckErrorReason;
}

export const systemApi = {
  shutdown: () => api.post<SystemActionResponse>("/system/shutdown", {}),
  restart: () => api.post<SystemActionResponse>("/system/restart", {}),
  update: () => api.post<SystemActionResponse>("/system/update", {}),
  rebuild: () => api.post<SystemActionResponse>("/system/rebuild", {}),
  checkUpdate: () => api.get<SystemUpdateCheck>("/system/update-check"),
};
