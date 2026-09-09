import { useCallback, useMemo, useRef, useState } from "react";
import type { MailHeader } from "../../api/emailTools";
import {
  EMPTY_SELECTION,
  clearSelection,
  pruneSelection,
  selectAll,
  selectAllState,
  selectRange,
  toggleRow,
  type RowSelection,
} from "../../lib/row-selection";
import { runBulk } from "../../lib/bulk-run";
import type { EmailListView } from "../../lib/email-list-view";
import {
  messageSelectionId,
  resetForChange,
  summarizeEmailBulkRun,
  type EmailBulkAction,
} from "../../lib/email-selection";

/**
 * Ticking several unrelated messages and acting on all of them at once.
 *
 * The mail list could already act on a whole sender's mail in one go, but only
 * a whole sender's: four messages from four different people meant four
 * separate rounds of clicking. This holds the ticks and runs the existing
 * one-message action over each ticked message in turn.
 *
 * It deliberately does not know how to talk to a mailbox. The page passes in
 * the same two functions its own buttons use, so a selected mark-read is the
 * same call, against the same endpoint, with the same bookkeeping, as a
 * single mark-read. Nothing new was added on the server for this.
 */

export interface EmailBulkProgress {
  action: EmailBulkAction;
  done: number;
  total: number;
}

export interface EmailBulkOutcome {
  tone: "success" | "warning" | "error";
  message: string;
}

export interface UseEmailBulkSelectionOptions {
  /** Mark one message read. The page's own mark-read button, reused. */
  markRead: (msg: MailHeader) => Promise<void>;
  /** Move one message. The page's own move button, reused. */
  moveToFolder: (msg: MailHeader, targetFolder: string) => Promise<void>;
  /** Refresh the lists. Called once when a run ends, not once per message. */
  invalidateLists: () => void;
}

/**
 * Three at a time.
 *
 * Every message is its own request to the mail plugin, which holds one IMAP
 * connection per mailbox, so firing fifty at once is a good way to make the
 * connection drop and turn a tidy-up into a page of errors. The same number
 * the Help Scout side settled on, for the same reason.
 */
export const EMAIL_BULK_CONCURRENCY = 3;

export function useEmailBulkSelection({
  markRead,
  moveToFolder,
  invalidateLists,
}: UseEmailBulkSelectionOptions) {
  const [selectMode, setSelectMode] = useState(false);
  const [selection, setSelection] = useState<RowSelection>(EMPTY_SELECTION);
  const [progress, setProgress] = useState<EmailBulkProgress | null>(null);
  const [outcome, setOutcome] = useState<EmailBulkOutcome | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);

  const running = progress !== null;

  const clear = useCallback(() => {
    setSelection(clearSelection());
    setOutcome(null);
  }, []);

  const startSelecting = useCallback(() => {
    setSelectMode(true);
  }, []);

  const stopSelecting = useCallback(() => {
    setSelectMode(false);
    setSelection(clearSelection());
    setOutcome(null);
  }, []);

  /**
   * Something changed underneath the ticks, so they are thrown away.
   *
   * The rules for which changes also switch the checkboxes off live in
   * lib/email-selection.ts, where they can be read on their own.
   */
  const resetFor = useCallback(
    (change: "tab" | "mailbox" | "folder" | "company", nextView?: EmailListView) => {
      setSelection(clearSelection());
      setOutcome(null);
      if (resetForChange(change, nextView) === "leave-mode") setSelectMode(false);
    },
    [],
  );

  /**
   * The rows on screen right now, newest first, so ticks for rows that have
   * since gone can be dropped.
   *
   * Not while a run is going: each message is hidden the moment its call
   * starts, so pruning mid-run would empty the very selection the run is
   * working from and take the progress line with it.
   */
  const syncVisible = useCallback((orderedIds: readonly string[]) => {
    if (runningRef.current) return;
    setSelection((current) => pruneSelection(current, orderedIds));
  }, []);

  const toggle = useCallback((uid: number, orderedIds: readonly string[], shiftKey: boolean) => {
    const id = messageSelectionId(uid);
    setSelection((current) =>
      shiftKey ? selectRange(current, orderedIds, id) : toggleRow(current, id),
    );
    setOutcome(null);
  }, []);

  /**
   * "Select visible messages". Visible really does mean visible: the list only
   * ever holds the newest fifty, and a tab or a folder narrows it further, so
   * this can never reach a message the person cannot see.
   */
  const selectVisible = useCallback((orderedIds: readonly string[]) => {
    setSelection((current) =>
      selectAllState(current, orderedIds) === "all" ? clearSelection() : selectAll(orderedIds),
    );
    setOutcome(null);
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const run = useCallback(
    async (action: EmailBulkAction, messages: readonly MailHeader[], targetFolder?: string) => {
      if (runningRef.current || messages.length === 0) return;
      if (action === "move" && !targetFolder) return;

      const controller = new AbortController();
      abortRef.current = controller;
      runningRef.current = true;
      setOutcome(null);
      setProgress({ action, done: 0, total: messages.length });
      let done = 0;

      try {
        const result = await runBulk(
          messages,
          async (msg) => {
            if (action === "read") await markRead(msg);
            else await moveToFolder(msg, targetFolder!);
          },
          {
            concurrency: EMAIL_BULK_CONCURRENCY,
            signal: controller.signal,
            onSettled: () => {
              done += 1;
              setProgress({ action, done, total: messages.length });
            },
          },
        );

        setOutcome(summarizeEmailBulkRun(result, action));
        // Whatever did not happen stays ticked, so trying again is one click
        // and cannot touch the messages that already moved. Set outright
        // rather than pruned: a failed row has been off the list since its
        // optimistic hide went in, so pruning would drop it.
        const unfinished = [...result.failed.map((f) => f.item), ...result.skipped];
        setSelection(
          unfinished.length === 0
            ? clearSelection()
            : {
              selected: new Set(unfinished.map((msg) => messageSelectionId(msg.uid))),
              anchorId: null,
            },
        );
      } finally {
        runningRef.current = false;
        setProgress(null);
        abortRef.current = null;
        // Once, at the end. Per message means fifty refetches of the same
        // list while the run is still going.
        invalidateLists();
      }
    },
    [invalidateLists, markRead, moveToFolder],
  );

  return useMemo(
    () => ({
      selectMode,
      startSelecting,
      stopSelecting,
      selection,
      selectedCount: selection.selected.size,
      isSelected: (uid: number) => selection.selected.has(messageSelectionId(uid)),
      selectAllState: (orderedIds: readonly string[]) => selectAllState(selection, orderedIds),
      syncVisible,
      toggle,
      selectVisible,
      clear,
      resetFor,
      run,
      cancel,
      progress,
      outcome,
      running,
    }),
    [
      cancel,
      clear,
      outcome,
      progress,
      resetFor,
      run,
      running,
      selectMode,
      selectVisible,
      selection,
      startSelecting,
      stopSelecting,
      syncVisible,
      toggle,
    ],
  );
}
