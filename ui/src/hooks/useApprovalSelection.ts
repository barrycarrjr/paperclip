import { useCallback, useEffect, useRef, useState } from "react";
import {
  resolveApprovalsInBulk,
  type BulkApprovalAction,
  type BulkApprovalResult,
} from "../lib/approval-bulk";

/**
 * Tick-box selection for a list of approvals, plus the bulk approve/reject
 * run over it. Shared by the company Approvals page and Portfolio Approvals.
 *
 * Only ids in `selectableIds` ever count as selected, so an approval that
 * gets decided elsewhere, or drops out of the current filter, quietly leaves
 * the selection instead of being acted on unseen. Changing `resetKey` (the
 * company, tab or filter) clears the selection.
 */
export function useApprovalSelection(selectableIds: string[], resetKey: string) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [runningAction, setRunningAction] = useState<BulkApprovalAction | null>(null);

  const prevKeyRef = useRef(resetKey);
  useEffect(() => {
    if (prevKeyRef.current === resetKey) return;
    prevKeyRef.current = resetKey;
    setPicked(new Set());
  }, [resetKey]);

  const selectedIds = selectableIds.filter((id) => picked.has(id));
  const selectedSet = new Set(selectedIds);

  const toggle = useCallback((id: string, next: boolean) => {
    setPicked((prev) => {
      const n = new Set(prev);
      if (next) n.add(id); else n.delete(id);
      return n;
    });
  }, []);

  const setMany = useCallback((ids: string[], next: boolean) => {
    setPicked((prev) => {
      const n = new Set(prev);
      for (const id of ids) {
        if (next) n.add(id); else n.delete(id);
      }
      return n;
    });
  }, []);

  const clear = useCallback(() => setPicked(new Set()), []);

  async function run(action: BulkApprovalAction): Promise<BulkApprovalResult | null> {
    if (runningAction || selectedIds.length === 0) return null;
    setRunningAction(action);
    try {
      const result = await resolveApprovalsInBulk(selectedIds, action);
      // Failures stay ticked so they can be retried or looked at.
      setMany(result.succeeded, false);
      return result;
    } finally {
      setRunningAction(null);
    }
  }

  return {
    selectedIds,
    isSelected: (id: string) => selectedSet.has(id),
    toggle,
    setMany,
    clear,
    run,
    runningAction,
  };
}

/** Tick-box state for a "select all" over `ids`, given what is selected. */
export function selectAllState(ids: string[], isSelected: (id: string) => boolean): boolean | "indeterminate" {
  if (ids.length === 0) return false;
  const count = ids.filter(isSelected).length;
  if (count === 0) return false;
  return count === ids.length ? true : "indeterminate";
}
