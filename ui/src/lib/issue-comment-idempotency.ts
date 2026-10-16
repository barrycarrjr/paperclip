import { ApiError } from "../api/client";
import type { IssueCorrectionDelivery } from "@paperclipai/shared";

export interface PendingCorrectionRequest {
  issueId: string;
  body: string;
  idempotencyKey: string;
  expectedAssigneeAgentId: string;
  targetSelectionKey: string;
}

export interface PendingCorrectionDelivery {
  request: PendingCorrectionRequest;
  /** Missing until the server confirms whether the idempotent write committed. */
  commentId?: string;
  reopen?: boolean;
  pending: IssueCorrectionDelivery["pending"];
}

export function correctionDeliveryStorageKey(companyId: string, issueId: string, userId: string): string {
  return `paperclip:correction-delivery:v1:${[companyId, issueId, userId].map(encodeURIComponent).join(":")}`;
}

export function readPendingCorrectionDeliveries(storageKey: string, issueId: string): {
  deliveries: PendingCorrectionDelivery[];
  storageError: string | null;
} {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return { deliveries: [], storageError: null };
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || !value.every((entry: PendingCorrectionDelivery | null) => {
      if (!entry) return false;
      const request = entry.request;
      return request?.issueId === issueId && typeof request.body === "string" && request.body.length > 0
        && typeof request.idempotencyKey === "string" && /^[A-Za-z0-9._:-]+$/.test(request.idempotencyKey)
        && typeof request.expectedAssigneeAgentId === "string" && request.expectedAssigneeAgentId.length > 0
        && (request.targetSelectionKey === "current-assignee" || request.targetSelectionKey === `reassign:${request.expectedAssigneeAgentId}`)
        && (entry.commentId === undefined || (typeof entry.commentId === "string" && entry.commentId.length > 0))
        && (entry.reopen === undefined || typeof entry.reopen === "boolean")
        && Array.isArray(entry.pending) && entry.pending.every((item) => item
          && typeof item.agentId === "string" && typeof item.reason === "string");
    })) throw new Error("Invalid saved correction delivery data");
    return { deliveries: value, storageError: null };
  } catch {
    return { deliveries: [], storageError: "Saved correction retries could not be read from this browser. Check your corrections before leaving this issue." };
  }
}

export function writePendingCorrectionDeliveries(storageKey: string, deliveries: PendingCorrectionDelivery[]): string | null {
  try {
    if (deliveries.length) window.localStorage.setItem(storageKey, JSON.stringify(deliveries));
    else window.localStorage.removeItem(storageKey);
    return null;
  } catch {
    return "Correction retries could not be saved in this browser. Keep this page open until delivery succeeds.";
  }
}

export function correctionRequestForBody(
  pending: PendingCorrectionRequest | null,
  issueId: string,
  body: string,
  expectedAssigneeAgentId: string | null | undefined,
  createId: () => string = () => crypto.randomUUID(),
  targetSelectionKey = "current-assignee",
): PendingCorrectionRequest {
  if (
    pending?.issueId === issueId &&
    pending.body === body &&
    pending.targetSelectionKey === targetSelectionKey
  ) return pending;
  if (!expectedAssigneeAgentId) throw new Error("Correction comments require an assigned agent.");
  return {
    issueId,
    body,
    idempotencyKey: `board.correction:v1_${createId()}`,
    expectedAssigneeAgentId,
    targetSelectionKey,
  };
}

export function pendingCorrectionAfterError(
  pending: PendingCorrectionRequest | null,
  error: unknown,
): PendingCorrectionRequest | null {
  if (
    error instanceof ApiError &&
    error.status === 409 &&
    error.body?.code === "correction_assignee_conflict"
  ) return null;
  return pending;
}
