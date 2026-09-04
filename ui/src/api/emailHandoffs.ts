import type { EmailDelegationState } from "@paperclipai/shared";
import { api } from "./client";

/** One record of an email having been handed to an agent. */
export interface EmailHandoff {
  id: string;
  issueId: string;
  companyId: string;
  pluginId: string;
  sourceKey: string;
  mailbox: string;
  folder: string | null;
  messageId: string | null;
  status: EmailDelegationState;
  delegatedByUserId: string | null;
  delegatedToAgentId: string | null;
  delegatedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  handedBackReason: string | null;
  previousDelegationId: string | null;
  /** none | queued | sent | failed */
  replyState: string;
  replyError: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ResolveHandoffResult {
  delegation: EmailHandoff;
  reply:
    | { replyState: "none"; reason: string }
    | { replyState: "queued" }
    | { replyState: "sent" }
    | { replyState: "failed"; error: string };
}

const base = (companyId: string, issueId: string) =>
  `/companies/${companyId}/issues/${issueId}/email-delegations`;

export const emailHandoffsApi = {
  listForIssue: (companyId: string, issueId: string) =>
    api.get<EmailHandoff[]>(base(companyId, issueId)),

  acknowledge: (companyId: string, issueId: string, id: string, expectedVersion?: number) =>
    api.post<EmailHandoff>(`${base(companyId, issueId)}/${id}/acknowledge`, { expectedVersion }),

  /**
   * `replyBody` is sent to whoever sent the original email. Leaving it out
   * finishes the handover without sending anything.
   */
  resolve: (
    companyId: string,
    issueId: string,
    id: string,
    data: { replyBody?: string; resolutionNote?: string; expectedVersion?: number },
  ) => api.post<ResolveHandoffResult>(`${base(companyId, issueId)}/${id}/resolve`, data),

  handBack: (
    companyId: string,
    issueId: string,
    id: string,
    data: { reason: string; expectedVersion?: number },
  ) => api.post<EmailHandoff>(`${base(companyId, issueId)}/${id}/hand-back`, data),
};
