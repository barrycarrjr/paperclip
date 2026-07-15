import type { CalendarEvent } from "@paperclipai/shared";
import { formatDateTime } from "@/lib/utils";

/**
 * Per-source presentation. Only "paperclip" exists today; Google/Outlook are
 * kept in the map so a future source slots in without touching call sites. The
 * whole surface keys colour and legend visibility off `source`, so adding a
 * source here is the only change needed to light it up.
 */
export interface SourceMeta {
  label: string;
  /** Small solid dot (legend + calendar cells). */
  dot: string;
  /** Compact pill styling used for calendar day pills and list badges. */
  pill: string;
}

const SOURCE_META: Record<string, SourceMeta> = {
  paperclip: {
    label: "Paperclip",
    dot: "bg-indigo-500",
    pill: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border-indigo-500/25",
  },
  google: {
    label: "Google",
    dot: "bg-emerald-500",
    pill: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/25",
  },
  outlook: {
    label: "Outlook",
    dot: "bg-sky-500",
    pill: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/25",
  },
};

const FALLBACK_SOURCE_META: SourceMeta = {
  label: "Other",
  dot: "bg-neutral-400",
  pill: "bg-neutral-500/15 text-neutral-700 dark:text-neutral-300 border-neutral-500/25",
};

export function sourceMeta(source: string): SourceMeta {
  return SOURCE_META[source] ?? { ...FALLBACK_SOURCE_META, label: source };
}

/** The set of sources currently known to the surface (for the legend). */
export const KNOWN_SOURCES = ["paperclip"] as const;

export const CHANNEL_LABELS: Record<string, string> = {
  desktop: "Desktop",
  slack: "Slack",
  in_app: "In-app",
};

export function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Local calendar-day key (YYYY-MM-DD) for bucketing occurrences by day. */
export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export interface CalendarDayCell {
  date: Date;
  key: string;
  inMonth: boolean;
  isToday: boolean;
}

/**
 * Build the 6x7 (42 cell) month grid, padded so the first row starts on Sunday.
 * `viewMonth` may be any date within the target month.
 */
export function buildMonthGrid(viewMonth: Date): CalendarDayCell[] {
  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const startWeekday = firstOfMonth.getDay(); // 0 = Sunday
  const gridStart = new Date(year, month, 1 - startWeekday);
  const todayKey = dayKey(new Date());

  const cells: CalendarDayCell[] = [];
  for (let i = 0; i < 42; i += 1) {
    const date = new Date(
      gridStart.getFullYear(),
      gridStart.getMonth(),
      gridStart.getDate() + i,
    );
    const key = dayKey(date);
    cells.push({
      date,
      key,
      inMonth: date.getMonth() === month,
      isToday: key === todayKey,
    });
  }
  return cells;
}

/**
 * ISO range covering the full visible grid (including the padded days that spill
 * from adjacent months), so occurrences on those visible days are fetched too.
 */
export function monthRange(viewMonth: Date): { from: string; to: string } {
  const cells = buildMonthGrid(viewMonth);
  const first = cells[0]!.date;
  const last = cells[cells.length - 1]!.date;
  const from = new Date(first.getFullYear(), first.getMonth(), first.getDate(), 0, 0, 0, 0);
  const to = new Date(last.getFullYear(), last.getMonth(), last.getDate(), 23, 59, 59, 999);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** Bucket occurrences into local calendar days, dropping hidden sources. */
export function bucketOccurrencesByDay<T extends { start: string; source: string }>(
  occurrences: T[],
  hiddenSources: Set<string>,
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const occ of occurrences) {
    if (hiddenSources.has(occ.source)) continue;
    const key = dayKey(new Date(occ.start));
    const list = map.get(key);
    if (list) {
      list.push(occ);
    } else {
      map.set(key, [occ]);
    }
  }
  for (const list of map.values()) {
    list.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  }
  return map;
}

export function addMonths(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

export function formatMonthTitle(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/**
 * Human cadence summary for a calendar event:
 *  - once     -> the formatted anchor date/time
 *  - interval -> "Every N week(s), <weekday> HH:MM <tz>"
 *  - cron     -> the raw cron expression
 */
export function describeCadence(event: Pick<
  CalendarEvent,
  "scheduleKind" | "anchorAt" | "intervalUnit" | "intervalCount" | "timeOfDay" | "cronExpression" | "timezone"
>): string {
  if (event.scheduleKind === "once") {
    return event.anchorAt ? formatDateTime(event.anchorAt) : "One time";
  }

  if (event.scheduleKind === "interval") {
    const count = event.intervalCount ?? 1;
    const unit = event.intervalUnit ?? "day";
    const unitLabel = count === 1 ? unit : `${unit}s`;
    const detail: string[] = [];
    if (unit === "week" && event.anchorAt) {
      detail.push(new Date(event.anchorAt).toLocaleDateString("en-US", { weekday: "short" }));
    }
    if (event.timeOfDay) detail.push(event.timeOfDay);
    if (event.timezone) detail.push(event.timezone);
    const head = `Every ${count} ${unitLabel}`;
    return detail.length > 0 ? `${head}, ${detail.join(" ")}` : head;
  }

  if (event.scheduleKind === "cron") {
    return event.cronExpression ?? "Custom schedule";
  }

  return "—";
}

/** Format an ISO/Date value for a native `<input type="datetime-local">`. */
export function toDateTimeLocalValue(value: string | Date | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Format an ISO/Date value for a native `<input type="date">`. */
export function toDateInputValue(value: string | Date | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
