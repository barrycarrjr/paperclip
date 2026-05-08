import { api } from "./client";

export interface SystemActionResponse {
  ok: boolean;
  action: "shutdown" | "restart" | "update" | "rebuild";
  message?: string;
  usedLauncher?: boolean;
  error?: string;
}

export const systemApi = {
  shutdown: () => api.post<SystemActionResponse>("/system/shutdown", {}),
  restart: () => api.post<SystemActionResponse>("/system/restart", {}),
  update: () => api.post<SystemActionResponse>("/system/update", {}),
  rebuild: () => api.post<SystemActionResponse>("/system/rebuild", {}),
};
