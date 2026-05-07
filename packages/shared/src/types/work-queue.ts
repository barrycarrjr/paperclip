import type { WorkQueueItemStatus } from "../validators/work-queue.js";

export interface WorkQueue {
  id: string;
  companyId: string;
  slug: string;
  name: string;
  description: string | null;
  defaultAssigneeAgentId: string | null;
  defaultProjectId: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkQueueItem {
  id: string;
  queueId: string;
  companyId: string;
  externalSource: string | null;
  externalId: string | null;
  payload: Record<string, unknown>;
  status: WorkQueueItemStatus;
  priority: number;
  claimedByAgentId: string | null;
  claimedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  failureReason: string | null;
  issueId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
