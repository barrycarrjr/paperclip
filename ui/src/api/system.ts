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
  | "branch_not_on_remote"
  | "github_unreachable"
  | "github_error";

/**
 * Which gap is being reported. `remote_ahead` needs a pull, `build_behind`
 * needs a rebuild of what is already checked out.
 */
export type SystemUpdateCheckReason = "remote_ahead" | "build_behind";

/**
 * Which way round this copy and GitHub are.
 *
 * Only `behind` has anything to pull. `ahead` means this copy is newer than
 * what is published, `diverged` means both sides have changed, and
 * `no_remote_branch` means GitHub has never seen this branch. `unknown` means
 * the answer could not be worked out, and is never dressed up as anything else.
 */
export type SystemRemoteRelation =
  | "level"
  | "behind"
  | "ahead"
  | "diverged"
  | "no_remote_branch"
  | "unknown";

export interface SystemUpdateCheck {
  available: boolean;
  /** What the checkout is on. */
  localCommit: string | null;
  /** What GitHub has on the tracked branch. */
  remoteCommit: string | null;
  /** What was last built and installed. */
  installedCommit: string | null;
  /**
   * Whether this copy runs the working tree's own source rather than a build
   * of it. When it is true there is no build in the path, so no rebuild is
   * ever offered and the account card says so.
   */
  runningFromSource: boolean;
  reason: SystemUpdateCheckReason | null;
  /** Which way round this copy and GitHub are, or null when nothing was compared. */
  remoteRelation: SystemRemoteRelation | null;
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
