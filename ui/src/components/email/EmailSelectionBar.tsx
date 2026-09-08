import { FolderOpen, Loader2, MailOpen, MoveRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "../../lib/utils";
import type { EmailBulkOutcome, EmailBulkProgress } from "./useEmailBulkSelection";

/**
 * The strip that sits above the mail list while the checkboxes are on.
 *
 * It stays on screen with nothing ticked, because "Select visible messages"
 * lives in it and that is how a person with fifty rows in front of them
 * starts. Each action is a run of one call per message rather than a single
 * batch call, so the strip has to keep saying how far through it is and then
 * hold the result, instead of flashing a message that is gone before anyone
 * has read it. A part-finished run says so in the same place, in words that
 * cannot be mistaken for a clean success.
 *
 * There is no delete here on purpose. Deleting mail is not part of this, and
 * a mistaken tick that only marks something read or files it in a folder is
 * recoverable in a way a mistaken tick that empties a mailbox is not.
 */

export function EmailSelectionBar({
  count,
  selectAllState,
  onSelectVisible,
  onMarkRead,
  onMove,
  folders,
  onDone,
  onCancel,
  progress = null,
  outcome = null,
  className,
}: {
  /** How many messages are ticked. */
  count: number;
  /** Whether the visible rows are all, some, or none of them ticked. */
  selectAllState: "none" | "some" | "all";
  onSelectVisible: () => void;
  onMarkRead: () => void;
  onMove: (targetFolder: string) => void;
  /** Folders this mailbox has, minus the one being looked at. */
  folders: readonly string[];
  /** Leave select mode. Anything ticked is forgotten. */
  onDone: () => void;
  /** Stop a run part way. Calls already sent still finish. */
  onCancel?: () => void;
  progress?: EmailBulkProgress | null;
  outcome?: EmailBulkOutcome | null;
  className?: string;
}) {
  const running = progress !== null;
  const outcomeClass = outcome
    ? {
      success: "text-emerald-700 dark:text-emerald-400",
      warning: "text-amber-700 dark:text-amber-400",
      error: "text-red-700 dark:text-red-400",
    }[outcome.tone]
    : "";

  return (
    <div
      role="region"
      aria-label="Selected messages"
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-card px-3 py-2 shrink-0",
        className,
      )}
    >
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Checkbox
          checked={
            selectAllState === "all" ? true : selectAllState === "some" ? "indeterminate" : false
          }
          disabled={running}
          aria-label={selectAllState === "all" ? "Clear selection" : "Select visible messages"}
          onCheckedChange={() => onSelectVisible()}
        />
        {selectAllState === "all" ? "Clear selection" : "Select visible messages"}
      </label>

      <span className="text-xs font-medium tabular-nums">
        {running ? `${progress.total} selected` : `${count} selected`}
      </span>

      {running ? (
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span className="tabular-nums">
            {progress.done} of {progress.total} done
          </span>
        </span>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            disabled={count === 0}
            title="Mark every ticked message as read."
            onClick={onMarkRead}
          >
            <MailOpen className="mr-1 h-3.5 w-3.5" />
            Mark read
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                disabled={count === 0}
                title="File every ticked message in a folder."
              >
                <MoveRight className="mr-1 h-3.5 w-3.5" />
                Move selected
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-64 overflow-y-auto">
              {folders.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted-foreground">Loading folders...</div>
              ) : (
                folders.map((folder) => (
                  <DropdownMenuItem key={folder} onSelect={() => onMove(folder)}>
                    <FolderOpen className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                    {folder}
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      <div className="ml-auto flex items-center gap-2">
        {outcome && !running && (
          <span className={cn("text-xs", outcomeClass)} role="status">
            {outcome.message}
          </span>
        )}
        {running && onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Stop
          </button>
        )}
        {!running && (
          <button
            type="button"
            onClick={onDone}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Done
          </button>
        )}
      </div>
    </div>
  );
}
