import type { MemoryKind } from "../validators/memory.js";

export interface Memory {
  id: string;
  companyId: string;
  agentId: string | null;
  kind: MemoryKind;
  name: string;
  description: string | null;
  content: string;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
