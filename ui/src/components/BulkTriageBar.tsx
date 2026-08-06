import { Check, Clock, Loader2, ShieldCheck, VolumeX, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";

/**
 * The bar that appears once conversations are selected.
 *
 * Every one of these actions is a fan-out of single-conversation calls, which
 * takes real seconds and can partly fail, so the bar has to keep saying what
 * is going on rather than flashing a toast at the end. While a run is in
 * flight it shows how far through it is and offers a way to stop; afterwards
 * it holds the outcome until the operator moves on.
 */

export type BulkTriageAction = "pending" | "keep-always" | "auto-noise" | "close" | "spam";

export interface BulkTriageProgress {
  action: BulkTriageAction;
  done: number;
  total: number;
}

export interface BulkTriageOutcome {
  tone: "success" | "warning" | "error";
  message: string;
}

const ACTIONS: Array<{
  action: BulkTriageAction;
  label: string;
  hint: string;
  icon: typeof Clock;
  destructive?: boolean;
}> = [
  {
    action: "pending",
    label: "Mark pending",
    hint: "Park these. They drop off the active list and stay open.",
    icon: Clock,
  },
  {
    action: "keep-always",
    label: "Keep always",
    hint: "Tag these keep-always so this sender is never auto-triaged.",
    icon: ShieldCheck,
  },
  {
    action: "auto-noise",
    label: "Auto-noise and close",
    hint: "Tag these auto-noise and close them.",
    icon: VolumeX,
  },
  { action: "close", label: "Close", hint: "Close these conversations.", icon: Check },
  {
    action: "spam",
    label: "Spam",
    hint: "Mark these as spam.",
    icon: X,
    destructive: true,
  },
];

export function BulkTriageBar({
  count,
  onAction,
  onClear,
  onCancel,
  progress = null,
  outcome = null,
  disabledReason = null,
  className,
}: {
  /** How many conversations are selected. The bar renders nothing at zero. */
  count: number;
  onAction: (action: BulkTriageAction) => void;
  onClear: () => void;
  /** Stop a run in flight. Work already sent still finishes. */
  onCancel?: () => void;
  progress?: BulkTriageProgress | null;
  outcome?: BulkTriageOutcome | null;
  /** Set when the actions cannot run at all, e.g. the plugin is read-only. */
  disabledReason?: string | null;
  className?: string;
}) {
  const running = progress !== null;
  // Stay mounted while there is a run to narrate or a result to read. Keying
  // purely off the selection meant the bar disappeared the moment a run
  // started emptying it, taking the progress, the Stop control and the
  // outcome with it.
  if (count === 0 && !running && !outcome) return null;
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
      aria-label="Bulk triage"
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 border border-border bg-card px-3 py-2",
        className,
      )}
    >
      <span className="text-[12px] font-medium tabular-nums">
        {running ? `${progress.total} selected` : `${count} selected`}
      </span>

      {running ? (
        <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span className="tabular-nums">
            {progress.done} of {progress.total} done
          </span>
        </span>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {ACTIONS.map(({ action, label, hint, icon: Icon, destructive }) => (
            <Button
              key={action}
              size="sm"
              variant={destructive ? "destructive" : "outline"}
              className="h-7 px-2 text-[12px]"
              disabled={!!disabledReason || count === 0}
              title={disabledReason ?? hint}
              onClick={() => onAction(action)}
            >
              <Icon className="mr-1 h-3.5 w-3.5" />
              {label}
            </Button>
          ))}
        </div>
      )}

      <div className="ml-auto flex items-center gap-2">
        {outcome && !running && (
          <span className={cn("text-[12px]", outcomeClass)} role="status">
            {outcome.message}
          </span>
        )}
        {running && onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="text-[12px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Stop
          </button>
        )}
        {!running && (
          <button
            type="button"
            onClick={onClear}
            className="text-[12px] text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        )}
      </div>

      {disabledReason && (
        <p className="w-full text-[11px] text-muted-foreground">{disabledReason}</p>
      )}
    </div>
  );
}
