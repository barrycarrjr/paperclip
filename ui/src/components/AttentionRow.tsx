import {
  ClipboardCheck,
  Clock,
  HelpCircle,
  Mail,
  ShieldCheck,
  TriangleAlert,
  UserPlus,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SNOOZE_PRESETS,
  SNOOZE_PRESET_LABELS,
  resolveSnoozePreset,
  type SnoozePreset,
} from "../lib/snooze-presets";
import type { AttentionKind, AttentionRow as AttentionRowData } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { cn } from "../lib/utils";

/**
 * One row of the attention queue, rendered identically everywhere it
 * appears (Brief, Inbox, and any future surface). Replaces the one-off
 * PendingQuestionRow and ReviewGateRow: the whole point of the queue is
 * that a decision looks and reads the same wherever you meet it.
 */

const KIND_PRESENTATION: Record<
  AttentionKind,
  { icon: typeof HelpCircle; cta: string; tint: string }
> = {
  approval: { icon: ShieldCheck, cta: "Decide", tint: "text-amber-600 dark:text-amber-400" },
  question: { icon: HelpCircle, cta: "Answer", tint: "text-sky-600 dark:text-sky-400" },
  sign_off: { icon: ClipboardCheck, cta: "Review", tint: "text-violet-600 dark:text-violet-400" },
  run_failure: { icon: TriangleAlert, cta: "Open run", tint: "text-red-600 dark:text-red-400" },
  budget_stop: { icon: Wallet, cta: "Open budgets", tint: "text-red-600 dark:text-red-400" },
  join_request: { icon: UserPlus, cta: "Decide", tint: "text-sky-600 dark:text-sky-400" },
  email_sender: { icon: Mail, cta: "Set a rule", tint: "text-sky-600 dark:text-sky-400" },
};

/** "3h", "2d", "just now" - how long this has been waiting. */
export function formatWaited(sinceMs: number | null, nowMs: number): string | null {
  if (sinceMs == null) return null;
  const seconds = Math.max(0, Math.round((nowMs - sinceMs) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function AttentionRow({
  row,
  hrefPrefix = "",
  nowMs = Date.now(),
  className,
  onSnooze,
}: {
  row: AttentionRowData;
  /** Portfolio surfaces pass "/{issuePrefix}" so links cross companies. */
  hrefPrefix?: string;
  nowMs?: number;
  className?: string;
  /**
   * Put this row away until the given moment. Omitted on surfaces that only
   * display rows, so the control simply does not appear there.
   */
  onSnooze?: (row: AttentionRowData, until: Date) => void;
}) {
  const presentation = KIND_PRESENTATION[row.kind];
  const Icon = presentation.icon;
  const waited = formatWaited(row.blockedSinceMs, nowMs);
  const stopped = row.blocking === "stopped";

  return (
    <Link
      to={`${hrefPrefix}${row.href}`}
      className={cn(
        "group/attention flex items-start gap-3 px-4 py-2.5 text-sm no-underline hover:bg-accent/40",
        className,
      )}
    >
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", presentation.tint)} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate font-medium">{row.title}</span>
          {row.count > 1 && (
            <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] font-semibold text-muted-foreground">
              {row.count}
            </span>
          )}
          {stopped && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-red-500/30 bg-red-500/10 px-1.5 py-px text-[10px] font-semibold text-red-700 dark:text-red-400">
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
              {waited ? `stopped ${waited}` : "stopped"}
            </span>
          )}
        </div>
        {(row.detail || (!stopped && waited)) && (
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {row.detail}
            {row.detail && !stopped && waited ? " · " : ""}
            {!stopped && waited ? `waiting ${waited}` : ""}
          </div>
        )}
        {row.consequence && (
          <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground/90">
            {row.consequence}
          </div>
        )}
      </div>
      {onSnooze && (
        // Inside a Link, so the menu has to swallow the navigation as well as
        // the bubble, or opening it would follow the row.
        <span
          className="shrink-0 self-center"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Snooze: ${row.title}`}
                title="Not now"
                className="opacity-0 transition-opacity group-hover/attention:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
              >
                <Clock className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {SNOOZE_PRESETS.map((preset: SnoozePreset) => (
                <DropdownMenuItem
                  key={preset}
                  // Resolved from the clock at the moment of the click, not
                  // from nowMs. nowMs is the display clock the page passed in
                  // at render, and React Query's structural sharing means a
                  // list that keeps returning identical rows does not
                  // re-render, so it can sit still for a long time. Resolving
                  // "in an hour" against it could land in the past, which the
                  // server rejects.
                  onSelect={() => onSnooze(row, resolveSnoozePreset(preset, new Date()))}
                >
                  {SNOOZE_PRESET_LABELS[preset]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      )}
      <span className="shrink-0 self-center rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-foreground">
        {presentation.cta}
      </span>
    </Link>
  );
}
