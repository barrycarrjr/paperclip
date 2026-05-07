import type {
  CompleteWorkQueueItem,
  CreateWorkQueue,
  EnqueueWorkQueueItem,
  FailWorkQueueItem,
  UpdateWorkQueue,
  WorkQueue,
  WorkQueueItem,
  WorkQueueItemStatus,
} from "@paperclipai/shared";
import { api } from "./client";

export interface WorkQueueItemListFilter {
  status?: WorkQueueItemStatus;
  limit?: number;
}

function buildQuery(filter: WorkQueueItemListFilter): string {
  const params = new URLSearchParams();
  if (filter.status) params.set("status", filter.status);
  if (filter.limit !== undefined) params.set("limit", String(filter.limit));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const workQueuesApi = {
  list: (companyId: string) => api.get<WorkQueue[]>(`/companies/${companyId}/work-queues`),
  get: (id: string) => api.get<WorkQueue>(`/work-queues/${id}`),
  create: (companyId: string, data: CreateWorkQueue) =>
    api.post<WorkQueue>(`/companies/${companyId}/work-queues`, data),
  update: (id: string, data: UpdateWorkQueue) =>
    api.patch<WorkQueue>(`/work-queues/${id}`, data),
  remove: (id: string) => api.delete<WorkQueue>(`/work-queues/${id}`),
  listItems: (queueId: string, filter: WorkQueueItemListFilter = {}) =>
    api.get<WorkQueueItem[]>(`/work-queues/${queueId}/items${buildQuery(filter)}`),
  enqueue: (queueId: string, data: EnqueueWorkQueueItem) =>
    api.post<WorkQueueItem>(`/work-queues/${queueId}/items`, data),
  getItem: (itemId: string) => api.get<WorkQueueItem>(`/work-queue-items/${itemId}`),
  claimItem: (itemId: string) => api.post<WorkQueueItem>(`/work-queue-items/${itemId}/claim`, {}),
  completeItem: (itemId: string, data: CompleteWorkQueueItem = {}) =>
    api.post<WorkQueueItem>(`/work-queue-items/${itemId}/complete`, data),
  failItem: (itemId: string, data: FailWorkQueueItem) =>
    api.post<WorkQueueItem>(`/work-queue-items/${itemId}/fail`, data),
  cancelItem: (itemId: string) =>
    api.post<WorkQueueItem>(`/work-queue-items/${itemId}/cancel`, {}),
};
