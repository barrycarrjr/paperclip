import { useId, useState } from "react";
import { Ban, CheckCircle2, ChevronDown, CircleDashed, Inbox, Loader2, XCircle } from "lucide-react";
import { Link } from "@/lib/router";
import { cn } from "../lib/utils";
import {
  describeChatTool,
  draftedApprovalId,
  formatElapsed,
  summarizeToolStep,
  type ToolStepState,
  type ToolStepSummary,
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

function stepState(status: Props["status"], result: Props["result"]): ToolStepState {
  if (status === "pending") return "running";
  if (status === "denied") return "denied";
  if (status === "interrupted") return "interrupted";
  return result && !result.ok ? "failed" : "done";
}

const STATE_ICON: Record<ToolStepState, { icon: typeof CheckCircle2; className: string; label: string }> = {
  running: { icon: Loader2, className: "animate-spin text-muted-foreground motion-reduce:animate-none", label: "Running" },
  done: { icon: CheckCircle2, className: "text-muted-foreground", label: "Done" },
  failed: { icon: XCircle, className: "text-destructive", label: "Failed" },
  denied: { icon: Ban, className: "text-amber-600 dark:text-amber-500", label: "Denied" },
  interrupted: { icon: CircleDashed, className: "text-muted-foreground", label: "No result" },
};

/**
 * One step Clippy took (a tool call) inside its reply. Collapsed, it is one
 * plain line: a status icon, what was done ("Created issue HQ-1", linked),
 * and a chevron. The raw parameters and the raw result, which used to fill
 * the card face in every conversation, are behind the chevron for anyone who
 * wants them. A step waiting for the person's OK is drawn by
 * ClippyPermissionCard instead.
 */
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
  const detailsId = useId();
  const presentation = describeChatTool(name, input);
  const state = stepState(status, result);
  const approvalId = result?.ok ? draftedApprovalId(result.data) : null;
  const summary: ToolStepSummary = approvalId
    ? { text: presentation.label, detail: "waiting for your approval" }
    : summarizeToolStep(name, input, state, result?.data);
  const running = state === "running";
  const now = useNowTick(running && startedAt != null);
  const timing = running
    ? startedAt != null
      ? formatElapsed(now - startedAt)
      : null
    : startedAt != null && completedAt != null
      ? formatElapsed(completedAt - startedAt)
      : null;
  const stateIcon = approvalId
    ? { icon: Inbox, className: "text-amber-600 dark:text-amber-500", label: "Waiting for approval" }
    : STATE_ICON[state];
  const StateIcon = stateIcon.icon;

  return (
    <div className={cn("my-1 rounded-md text-xs", open && "border border-border bg-background/60")}>
      <div className="flex min-w-0 items-center gap-1.5 px-1.5 py-1">
        <StateIcon role="img" aria-label={stateIcon.label} className={cn("size-3.5 shrink-0", stateIcon.className)} />
        <span className="min-w-0 flex-1 truncate" data-testid="tool-step-summary">
          <span className={cn("font-medium", state === "failed" ? "text-destructive" : "text-foreground")}>
            {summary.text}
          </span>
          {summary.issueIdentifier ? (
            <>
              {" "}
              <Link
                to={`/issues/${summary.issueIdentifier}`}
                className="font-medium text-foreground underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-foreground"
              >
                {summary.issueIdentifier}
              </Link>
            </>
          ) : null}
          {summary.detail ? <span className="text-muted-foreground"> · {summary.detail}</span> : null}
        </span>
        {approvalId ? (
          <Link
            to={`/approvals/${approvalId}`}
            className="shrink-0 font-medium text-foreground underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-foreground"
          >
            Open approval
          </Link>
        ) : null}
        {timing ? <span className="shrink-0 tabular-nums text-muted-foreground">{timing}</span> : null}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={detailsId}
          aria-label={open ? `Hide the details of "${presentation.label}"` : `Show the details of "${presentation.label}"`}
          title={open ? "Hide details" : "Show details"}
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        </button>
      </div>
      {open && (
        <div id={detailsId} className="space-y-2 border-t border-border px-2 py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase text-muted-foreground">Tool</span>
            <span className="font-mono">{name}</span>
            {presentation.via ? <span className="text-muted-foreground">from {presentation.via}</span> : null}
            {/* The streamed mutating flag is only trustworthy for built-in
                tools; the server hardcodes false for plugin tools, so a badge
                there would be a false safety claim. */}
            {mutating != null && !presentation.via && (
              <span
                className={cn(
                  "rounded-full px-1.5 py-px text-[10px] font-semibold",
                  mutating ? "bg-foreground text-background" : "bg-muted text-muted-foreground",
                )}
              >
                {mutating ? "does something real" : "read"}
              </span>
            )}
          </div>
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">Input</div>
            <pre className="max-h-48 overflow-auto rounded bg-muted/50 p-1.5 text-[11px]">
              {JSON.stringify(input, null, 2)}
            </pre>
          </div>
          {result && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">
                {result.ok ? "Result" : "Error"}
              </div>
              <pre className="max-h-72 overflow-auto rounded bg-muted/50 p-1.5 text-[11px]">
                {typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
