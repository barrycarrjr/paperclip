import type {
  CreateMemory,
  Memory,
  MemoryKind,
  UpdateMemory,
} from "@paperclipai/shared";
import { api } from "./client";

export interface MemoryListFilter {
  kind?: MemoryKind;
  agentId?: string;
  q?: string;
  limit?: number;
}

function buildQuery(filter: MemoryListFilter): string {
  const params = new URLSearchParams();
  if (filter.kind) params.set("kind", filter.kind);
  if (filter.agentId) params.set("agentId", filter.agentId);
  if (filter.q) params.set("q", filter.q);
  if (filter.limit !== undefined) params.set("limit", String(filter.limit));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const memoriesApi = {
  list: (companyId: string, filter: MemoryListFilter = {}) =>
    api.get<Memory[]>(`/companies/${companyId}/memories${buildQuery(filter)}`),
  get: (id: string) => api.get<Memory>(`/memories/${id}`),
  create: (companyId: string, data: CreateMemory) =>
    api.post<Memory>(`/companies/${companyId}/memories`, data),
  update: (id: string, data: UpdateMemory) => api.patch<Memory>(`/memories/${id}`, data),
  remove: (id: string) => api.delete<Memory>(`/memories/${id}`),
};
