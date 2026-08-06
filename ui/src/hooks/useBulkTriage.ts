import { useCallback, useMemo, useRef, useState } from "react";
import type { BulkTriageAction, BulkTriageOutcome, BulkTriageProgress } from "../components/BulkTriageBar";
import {
  EMPTY_SELECTION,
  clearSelection,
  pruneSelection,
  selectAll,
  selectAllState,
  selectRange,
  toggleRow,
  type RowSelection,
} from "../lib/row-selection";
import { runBulk, summarizeBulkRun } from "../lib/bulk-run";

/**
 * Selecting conversations and acting on all of them at once.
 *
 * Both triage views (the per-company Email page and the portfolio panel) had
 * the same gap and would otherwise grow the same feature twice; nearly
 * everything else about these two files is already duplicated, which is how
 * they drifted apart in the first place. The view supplies the four things
 * only it knows - how to talk to its account, how to note an optimistic
 * status, how to undo that note, and how to refresh its lists - and this hook
 * owns the rest.
 */

export const KEEP_ALWAYS_LABEL = "keep-always";
export const AUTO_NOISE_LABEL = "auto-noise";

/** Past tense, because it is used to report what happened. */
const ACTION_VERB: Record<BulkTriageAction, string> = {
  pending: "Marked pending",
  "keep-always": "Tagged keep-always",
  "auto-noise": "Tagged auto-noise and closed",
  close: "Closed",
  spam: "Marked as spam",
};

/** The status a row should show the moment you press the button. */
const OPTIMISTIC_STATUS: Record<BulkTriageAction, string | null> = {
  pending: "pending",
  // Tagging alone does not move a conversation, so there is nothing to note.
  "keep-always": null,
  "auto-noise": "closed",
  close: "closed",
  spam: "spam",
};

export interface BulkTriageApi {
  addLabel: (accountKey: string, conversationId: string, labels: string[]) => Promise<unknown>;
  changeStatus: (
    accountKey: string,
    conversationId: string,
    status: "active" | "pending" | "closed" | "spam",
  ) => Promise<unknown>;
}

export interface UseBulkTriageOptions {
  api: BulkTriageApi;
  accountKey: string;
  /** Show this conversation as already moved, before the server agrees. */
  noteStatus: (conversationId: string, status: string) => void;
  /** Undo that, because the call failed. */
  clearStatus: (conversationId: string) => void;
  /** Refresh the lists. Called once per run, not once per conversation. */
  invalidateLists: () => void;
}

export function useBulkTriage({
  api,
  accountKey,
  noteStatus,
  clearStatus,
  invalidateLists,
}: UseBulkTriageOptions) {
  const [selection, setSelection] = useState<RowSelection>(EMPTY_SELECTION);
  const [progress, setProgress] = useState<BulkTriageProgress | null>(null);
  const [outcome, setOutcome] = useState<BulkTriageOutcome | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);

  const running = progress !== null;

  /** Called by the view with the ids currently on screen, in order. */
  const syncVisible = useCallback((orderedIds: readonly string[]) => {
    // NOT while a run is going. Each item is shown as moved the moment it
    // starts, which takes its row off the list, which would prune it straight
    // back out of the selection the run is working from. The selection would
    // empty itself mid-run, taking the progress readout, the Stop control and
    // the result message with it, and leaving nothing selected to retry.
    if (runningRef.current) return;
    // Otherwise rows really do leave underneath the operator: the list
    // refetches every 30 seconds and other people's triage removes them.
    // Acting on a stale id would fire at an already-closed conversation.
    setSelection((current) => pruneSelection(current, orderedIds));
  }, []);

  const onToggle = useCallback((id: string, orderedIds: readonly string[], shiftKey: boolean) => {
    setSelection((current) => (shiftKey ? selectRange(current, orderedIds, id) : toggleRow(current, id)));
    setOutcome(null);
  }, []);

  const onSelectAll = useCallback((orderedIds: readonly string[]) => {
    setSelection((current) =>
      selectAllState(current, orderedIds) === "all" ? clearSelection() : selectAll(orderedIds),
    );
    setOutcome(null);
  }, []);

  const onClear = useCallback(() => {
    setSelection(clearSelection());
    setOutcome(null);
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const runAction = useCallback(
    async (action: BulkTriageAction, conversationIds: readonly string[]) => {
      if (running || conversationIds.length === 0) return;

      const controller = new AbortController();
      abortRef.current = controller;
      runningRef.current = true;
      setOutcome(null);
      setProgress({ action, done: 0, total: conversationIds.length });

      const optimistic = OPTIMISTIC_STATUS[action];
      let done = 0;

      try {
        const result = await runBulk(
          conversationIds,
          async (id) => {
            if (optimistic) noteStatus(id, optimistic);
            try {
              // Same order as the single-conversation buttons: tag first, so a
              // conversation is never closed carrying no explanation.
              if (action === "keep-always") {
                await api.addLabel(accountKey, id, [KEEP_ALWAYS_LABEL]);
              } else if (action === "auto-noise") {
                await api.addLabel(accountKey, id, [AUTO_NOISE_LABEL]);
                await api.changeStatus(accountKey, id, "closed");
              } else {
                await api.changeStatus(accountKey, id, action === "close" ? "closed" : action);
              }
            } catch (error) {
              if (optimistic) clearStatus(id);
              throw error;
            }
          },
          {
            signal: controller.signal,
            onSettled: () => {
              done += 1;
              setProgress({ action, done, total: conversationIds.length });
            },
          },
        );

        setOutcome(summarizeBulkRun(result, ACTION_VERB[action]));
        // Keep whatever could not be done selected, so a retry is one click
        // and does not touch the conversations that already moved. Set it
        // outright rather than pruning: pruning can only remove, and the rows
        // that failed have been off the list and out of the selection since
        // their optimistic note went in.
        const unfinished = [
          ...result.failed.map((failure) => failure.item),
          ...result.skipped,
        ];
        setSelection(
          unfinished.length === 0
            ? clearSelection()
            : { selected: new Set(unfinished), anchorId: null },
        );
      } finally {
        runningRef.current = false;
        setProgress(null);
        abortRef.current = null;
        // Once, at the end. Doing it per conversation means fifty refetches
        // of the same list while the run is still going.
        invalidateLists();
      }
    },
    [accountKey, api, clearStatus, invalidateLists, noteStatus, running],
  );

  return useMemo(
    () => ({
      selection,
      selectedCount: selection.selected.size,
      isSelected: (id: string) => selection.selected.has(id),
      selectAllState: (orderedIds: readonly string[]) => selectAllState(selection, orderedIds),
      syncVisible,
      onToggle,
      onSelectAll,
      onClear,
      runAction,
      cancel,
      progress,
      outcome,
      running,
    }),
    [cancel, onClear, onSelectAll, onToggle, outcome, progress, runAction, running, selection, syncVisible],
  );
}
