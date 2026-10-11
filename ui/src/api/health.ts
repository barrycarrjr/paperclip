import { apiErrorFromResponse, fetchOrNetworkError } from "./client";

export type DevServerHealthStatus = {
  enabled: true;
  restartRequired: boolean;
  reason: "backend_changes" | "pending_migrations" | "backend_changes_and_pending_migrations" | null;
  lastChangedAt: string | null;
  changedPathCount: number;
  changedPathsSample: string[];
  pendingMigrations: string[];
  autoRestartEnabled: boolean;
  activeRunCount: number;
  waitingForIdle: boolean;
  lastRestartAt: string | null;
};

export type HealthStatus = {
  status: "ok";
  version?: string;
  commit?: string;
  deploymentMode?: "local_trusted" | "authenticated";
  deploymentExposure?: "private" | "public";
  authReady?: boolean;
  bootstrapStatus?: "ready" | "bootstrap_pending";
  bootstrapInviteActive?: boolean;
  features?: {
    companyDeletionEnabled?: boolean;
  };
  devServer?: DevServerHealthStatus;
};

export const healthApi = {
  get: async (): Promise<HealthStatus> => {
    const res = await fetchOrNetworkError("/api/health", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      // With the database down the answer's `error` is the code
      // database_unreachable, which the app's front gate used to show as it was.
      throw await apiErrorFromResponse(res);
    }
    return res.json();
  },
};
