import type { MemoryKind } from "../validators/memory.js";

export interface Memory {
  id: string;
  companyId: string;
  agentId: string | null;
  kind: MemoryKind;
  name: string;
  description: string | null;
  content: string;
  /** Declared source identity; absent on older responses, null when unknown. */
  driveFileId?: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
