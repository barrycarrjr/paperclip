import { useState } from "react";
import { ChevronDown, ChevronRight, Eye, Inbox, Wrench } from "lucide-react";
import { Link } from "@/lib/router";
import { cn } from "../lib/utils";
import {
  describeChatTool,
  draftedApprovalId,
  formatElapsed,
  toolInputSummary,
  toolResultPreview,
} from "../lib/clippy-tool-labels";
import { useNowTick } from "../hooks/useNowTick";

interface Props {
  name: string;
  input: unknown;
  result?: { ok: boolean; data: unknown };
  /** "interrupted" = no result and no live stream state (e.g. after a
   * reload or dropped connection): the outcome is unknown, not running. */
  status?: "pending" | "completed" | "denied" | "interrupted";
  /** Whether this tool changes anything (streamed with the tool_use block). */
  mutating?: boolean;
  /** Epoch ms the call started; enables the live elapsed readout. */
  startedAt?: number;
  /** Epoch ms the result arrived; enables the duration readout. */
  completedAt?: number;
}

export function ClippyToolCallCard({
  name,
  input,
  result,
  status = "completed",
  mutating,
  startedAt,
  completedAt,
}: Props) {
  const [open, setOpen] = useState(false);
  const presentation = describeChatTool(name, input);
  const inputSummary = toolInputSummary(input);
  const approvalId = result?.ok ? draftedApprovalId(result.data) : null;
  const preview =
    status === "completed" && result?.ok && !approvalId
      ? toolResultPreview(result.data)
      : null;
  const running = status === "pending";
  const now = useNowTick(running && startedAt != null);
  const timing = running
    ? startedAt != null
      ? formatElapsed(now - startedAt)
      : null
    : startedAt != null && completedAt != null
      ? formatElapsed(completedAt - startedAt)
      : null;
  const tone = running
    ? "border-blue-300 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/30"
    : status === "denied"
      ? "border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30"
      : result && !result.ok
        ? "border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/30"
        : "border-border bg-muted/40";

  return (
    <div className={cn("my-2 rounded-md border text-xs", tone)}>
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        <Wrench className="h-3 w-3 shrink-0" />
        <span className="truncate font-medium">{presentation.label}</span>
        {inputSummary && (
          <span className="truncate text-muted-foreground">({inputSummary})</span>
        )}
        {/* The streamed mutating flag is only trustworthy for built-in
            tools; the server hardcodes false for plugin tools, so a badge
            there would be a false safety claim. */}
        {mutating != null && !presentation.via && (
          <span
            className={cn(
              "shrink-0 rounded-full px-1.5 py-px text-[10px] font-semibold",
              mutating
                ? "bg-foreground text-background"
                : "bg-muted text-muted-foreground",
            )}
          >
            {mutating ? "does something real" : "read"}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {timing && (
            <span className="text-[10px] tabular-nums text-muted-foreground">{timing}</span>
          )}
          {running && (
            <span className="text-[10px] text-blue-700 dark:text-blue-400">running…</span>
          )}
          {status === "interrupted" && (
            <span className="text-[10px] text-muted-foreground">no result</span>
          )}
          {status === "denied" && (
            <span className="text-[10px] text-amber-700 dark:text-amber-500">denied</span>
          )}
          {result && !result.ok && status === "completed" && (
            <span className="text-[10px] text-red-700 dark:text-red-400">error</span>
          )}
        </span>
      </button>
      {approvalId && (
        <div className="flex items-center gap-1.5 border-t border-current/10 px-2 py-1.5">
          <Inbox className="h-3 w-3 shrink-0 text-amber-700 dark:text-amber-500" />
          <span className="text-amber-800 dark:text-amber-400">
            Drafted and waiting for your approval.
          </span>
          <Link
            to={`/approvals/${approvalId}`}
            className="ml-auto shrink-0 font-medium text-blue-700 underline-offset-2 hover:underline dark:text-blue-400"
          >
            Open approval
          </Link>
        </div>
      )}
      {preview && (
        <div className="flex items-start gap-1.5 border-t border-current/10 px-2 py-1.5 text-muted-foreground">
          <Eye className="mt-px h-3 w-3 shrink-0" />
          <span className="min-w-0 break-words">{preview}</span>
        </div>
      )}
      {open && (
        <div className="space-y-2 border-t border-current/10 px-2 py-2">
          <div className="flex items-baseline gap-1.5">
            <span className="text-[10px] font-semibold uppercase text-muted-foreground">Tool</span>
            <span className="font-mono">{name}</span>
          </div>
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">Input</div>
            <pre className="max-h-48 overflow-auto rounded bg-background/60 p-1.5 text-[11px]">
              {JSON.stringify(input, null, 2)}
            </pre>
          </div>
          {result && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">
                {result.ok ? "Result" : "Error"}
              </div>
              <pre className="max-h-72 overflow-auto rounded bg-background/60 p-1.5 text-[11px]">
                {typeof result.data === "string"
                  ? result.data
                  : JSON.stringify(result.data, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
