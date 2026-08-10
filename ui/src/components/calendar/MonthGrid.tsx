import { useMemo } from "react";
import { Plus } from "lucide-react";
import type { CalendarOccurrence } from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { buildMonthGrid, bucketOccurrencesByDay, sourceMeta } from "./calendar-utils";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MAX_PILLS = 3;

interface MonthGridProps {
  viewMonth: Date;
  occurrences: CalendarOccurrence[];
  hiddenSources: Set<string>;
  onSelectOccurrence: (occurrence: CalendarOccurrence) => void;
  /**
   * Start a new reminder on a day. When given, empty space in a day cell
   * becomes clickable and each cell grows an add button on hover or focus.
   * Leave unset to keep the grid read-only.
   */
  onAddOnDay?: (day: Date) => void;
}

function occurrenceTime(occ: CalendarOccurrence): string {
  if (occ.allDay) return "All day";
  return new Date(occ.start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** Tooltip text: says plainly what a repeat count means. */
function occurrenceTooltip(occ: CalendarOccurrence): string {
  const when = occurrenceTime(occ);
  const repeats = occ.repeatsInDay ?? 1;
  return repeats > 1
    ? `${occ.title} · runs ${repeats} times today, first at ${when}`
    : `${occ.title} · ${when}`;
}

function OccurrencePill({
  occ,
  onSelect,
}: {
  occ: CalendarOccurrence;
  onSelect: (occurrence: CalendarOccurrence) => void;
}) {
  const meta = sourceMeta(occ.source);
  const repeats = occ.repeatsInDay ?? 1;
  return (
    <button
      type="button"
      onClick={() => onSelect(occ)}
      className={cn(
        "flex w-full items-center gap-1 rounded-sm border px-1.5 py-0.5 text-left text-[11px] leading-tight transition-[filter] hover:brightness-110",
        meta.pill,
      )}
      title={occurrenceTooltip(occ)}
    >
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", meta.dot)} />
      <span className="truncate">{occ.title}</span>
      {repeats > 1 ? (
        // shrink-0 so the count survives when the title is cut short. It is the
        // difference between "runs today" and "runs four times today", which
        // was being truncated away when it lived in the title string.
        <span className="ml-auto shrink-0 font-medium tabular-nums opacity-80">×{repeats}</span>
      ) : null}
    </button>
  );
}

export function MonthGrid({
  viewMonth,
  occurrences,
  hiddenSources,
  onSelectOccurrence,
  onAddOnDay,
}: MonthGridProps) {
  const cells = useMemo(() => buildMonthGrid(viewMonth), [viewMonth]);
  const byDay = useMemo(
    () => bucketOccurrencesByDay(occurrences, hiddenSources),
    [occurrences, hiddenSources],
  );

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="grid grid-cols-7 border-b border-border bg-muted/40">
        {WEEKDAYS.map((day) => (
          <div
            key={day}
            className="px-2 py-1.5 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            <span className="hidden sm:inline">{day}</span>
            <span className="sm:hidden">{day.charAt(0)}</span>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((cell) => {
          const dayOccurrences = byDay.get(cell.key) ?? [];
          const visible = dayOccurrences.slice(0, MAX_PILLS);
          const overflow = dayOccurrences.length - visible.length;
          return (
            <div
              key={cell.key}
              // Clicking blank space in the cell starts a reminder on that day.
              // The guard keeps the pills and the "+N more" popover working:
              // without it, opening an existing event would also open the new
              // reminder form behind it.
              onClick={
                onAddOnDay
                  ? (clickEvent) => {
                      if ((clickEvent.target as HTMLElement).closest("button")) return;
                      onAddOnDay(cell.date);
                    }
                  : undefined
              }
              className={cn(
                "group/day flex min-h-[96px] flex-col gap-1 border-b border-r border-border p-1.5 last:border-r-0 [&:nth-child(7n)]:border-r-0",
                !cell.inMonth && "bg-muted/20",
                onAddOnDay && "cursor-pointer transition-colors hover:bg-accent/30",
              )}
            >
              <div className="flex items-center justify-between">
                <span
                  className={cn(
                    "flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs tabular-nums",
                    cell.inMonth ? "text-foreground" : "text-muted-foreground/50",
                    cell.isToday && "bg-primary font-semibold text-primary-foreground",
                  )}
                >
                  {cell.date.getDate()}
                </span>
                {onAddOnDay ? (
                  <button
                    type="button"
                    onClick={() => onAddOnDay(cell.date)}
                    aria-label={`Add a reminder on ${cell.date.toLocaleDateString("en-US", {
                      weekday: "long",
                      month: "long",
                      day: "numeric",
                    })}`}
                    // Hidden until the day is hovered so the grid stays calm,
                    // but always reachable by keyboard via focus-visible.
                    className="flex h-5 w-5 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/day:opacity-100"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
              <div className="flex min-h-0 flex-col gap-0.5">
                {visible.map((occ) => (
                  <OccurrencePill
                    key={`${occ.eventId}-${occ.start}`}
                    occ={occ}
                    onSelect={onSelectOccurrence}
                  />
                ))}
                {overflow > 0 ? (
                  <Popover>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        className="rounded-sm px-1.5 py-0.5 text-left text-[11px] font-medium text-muted-foreground hover:bg-accent/50"
                      >
                        +{overflow} more
                      </button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-64 p-2">
                      <p className="mb-2 px-1 text-xs font-medium text-muted-foreground">
                        {cell.date.toLocaleDateString("en-US", {
                          weekday: "long",
                          month: "short",
                          day: "numeric",
                        })}
                      </p>
                      <div className="flex flex-col gap-1">
                        {dayOccurrences.map((occ) => (
                          <OccurrencePill
                            key={`${occ.eventId}-${occ.start}`}
                            occ={occ}
                            onSelect={onSelectOccurrence}
                          />
                        ))}
                      </div>
                    </PopoverContent>
                  </Popover>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
