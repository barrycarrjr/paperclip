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

/**
 * A handover with the two things the mail list always has to show beside it:
 * who has the message, and what work it turned into.
 *
 * Both can be null. An agent can be deleted after it was handed something,
 * and the work item can be gone too, so the screen says what it knows rather
 * than inventing a name.
 */
export interface EmailHandoffSummary extends EmailHandoff {
  issue: {
    id: string;
    identifier: string | null;
    title: string;
    status: string | null;
  } | null;
  agent: { id: string; name: string | null } | null;
}

/**
 * What happened when a person took a message back.
 *
 * The three parts are reported separately on purpose: the handover always
 * ends, but stopping the agent and freeing the work item can each fail on
 * their own, and a person who is told an agent stopped when it did not is
 * worse off than one who is told the truth.
 */
export interface TakeOverHandoffResult {
  delegation: EmailHandoff;
  run:
    | { state: "none" }
    | { state: "stopped"; runId: string }
    | { state: "failed"; error: string; runId: string | null };
  workItem: {
    state: "updated" | "unchanged" | "failed";
    unassignedAgent: boolean;
    statusChangedTo: string | null;
    error: string | null;
  };
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

  /** Every message an agent is holding in this company right now. */
  listForCompany: (companyId: string) =>
    api.get<EmailHandoffSummary[]>(`/companies/${companyId}/email-delegations`),

  /**
   * Take a message back from the agent. Sends nothing to anyone; the reason
   * is required because the record has to say why the agent stopped.
   */
  takeOver: (
    companyId: string,
    issueId: string,
    id: string,
    data: { reason: string; expectedVersion?: number },
  ) => api.post<TakeOverHandoffResult>(`${base(companyId, issueId)}/${id}/take-over`, data),

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
