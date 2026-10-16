import { useCallback, useEffect, useRef, useState } from "react";
import type { IssueComment } from "@paperclipai/shared";
import {
  correctionDeliveryStorageKey,
  readPendingCorrectionDeliveries,
  writePendingCorrectionDeliveries,
  type PendingCorrectionDelivery,
  type PendingCorrectionRequest,
} from "../lib/issue-comment-idempotency";

type Snapshot = { storageKey: string; deliveries: PendingCorrectionDelivery[]; storageError: string | null };

/** Keep saved, undelivered corrections separate from the next composer draft. */
export function usePendingIssueCorrections(input: {
  companyId: string | undefined;
  issueId: string | undefined;
  userId: string | null;
  sessionReady: boolean;
}) {
  const userId = input.userId ?? "local-board";
  const storageKey = input.companyId && input.issueId && input.sessionReady
    ? correctionDeliveryStorageKey(input.companyId, input.issueId, userId)
    : null;
  const activeStorageKey = useRef(storageKey);
  activeStorageKey.current = storageKey;
  const snapshots = useRef(new Map<string, Snapshot>());
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  useEffect(() => {
    if (!storageKey || !input.issueId) return;
    const load = () => {
      const next = { storageKey, ...readPendingCorrectionDeliveries(storageKey, input.issueId!) };
      snapshots.current.set(storageKey, next);
      setSnapshot(next);
    };
    // Keep the in-memory retry when browser storage is unavailable.
    const cached = snapshots.current.get(storageKey);
    if (cached?.storageError) setSnapshot(cached);
    else load();
    const onStorage = (event: StorageEvent) => {
      if (snapshots.current.get(storageKey)?.storageError) return;
      if (event.key === storageKey || event.key === null) load();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [storageKey, input.issueId]);

  const saveDeliveries = useCallback((key: string, issueId: string, update: (deliveries: PendingCorrectionDelivery[]) => PendingCorrectionDelivery[]) => {
    const cached = snapshots.current.get(key);
    const current = cached?.storageError ? cached : readPendingCorrectionDeliveries(key, issueId);
    const deliveries = update(current.deliveries);
    const next = { storageKey: key, deliveries, storageError: writePendingCorrectionDeliveries(key, deliveries) };
    snapshots.current.set(key, next);
    if (activeStorageKey.current === key) setSnapshot(next);
    return next.storageError === null;
  }, []);

  const recordRequest = useCallback((request: PendingCorrectionRequest, reopen?: boolean) => {
    if (!storageKey) return false;
    return saveDeliveries(storageKey, request.issueId, (deliveries) => [
      ...deliveries.filter((entry) => entry.request.idempotencyKey !== request.idempotencyKey),
      {
        request,
        ...(reopen === undefined ? {} : { reopen }),
        pending: [{
          agentId: request.expectedAssigneeAgentId,
          reason: "The server response was not confirmed. Retry to reconcile this correction safely.",
        }],
      },
    ]);
  }, [saveDeliveries, storageKey]);

  const discardRequest = useCallback((request: PendingCorrectionRequest) => {
    if (!storageKey) return;
    saveDeliveries(storageKey, request.issueId, (deliveries) => deliveries.filter(
      (entry) => entry.request.idempotencyKey !== request.idempotencyKey,
    ));
  }, [saveDeliveries, storageKey]);

  const recordDelivery = useCallback((request: PendingCorrectionRequest, comment: IssueComment, reopen?: boolean) => {
    // Use returned scope and author so a response arriving after navigation is
    // saved under the original issue, never the page currently on screen.
    const key = correctionDeliveryStorageKey(comment.companyId, comment.issueId, comment.authorUserId ?? userId);
    const pending = comment.correctionDelivery?.status === "pending";
    saveDeliveries(key, comment.issueId, (current) => {
      const deliveries = current.filter((entry) => entry.request.idempotencyKey !== request.idempotencyKey);
      if (pending) deliveries.push({
        request: { ...request, issueId: comment.issueId },
        commentId: comment.id,
        ...(reopen === undefined ? {} : { reopen }),
        pending: comment.correctionDelivery!.pending,
      });
      return deliveries;
    });
    return pending;
  }, [saveDeliveries, userId]);

  return {
    deliveries: snapshot?.storageKey === storageKey ? snapshot.deliveries : [],
    storageError: snapshot?.storageKey === storageKey ? snapshot.storageError : null,
    recordRequest,
    discardRequest,
    recordDelivery,
  };
}
