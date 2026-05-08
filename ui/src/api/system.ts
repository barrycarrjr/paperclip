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

export interface SystemUpdateCheck {
  available: boolean;
  localCommit: string | null;
  remoteCommit: string | null;
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
