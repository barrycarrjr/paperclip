import type { ServerLogPage, ServerLogQuery } from "@paperclipai/shared";
import { buildServerLogQueryString } from "@/lib/server-log-view";
import { api } from "./client";

export const instanceLogsApi = {
  get: (query: ServerLogQuery = {}) =>
    api.get<ServerLogPage>(`/instance/logs${buildServerLogQueryString(query)}`),
};
