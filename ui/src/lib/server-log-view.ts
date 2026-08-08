import type { ServerLogLevel, ServerLogQuery } from "@paperclipai/shared";

/**
 * Turns a log query into a query string, leaving out anything unset.
 *
 * Sending `level=` or `search=` when the operator has cleared the box would
 * filter on an empty string rather than not filtering, so empty values are
 * dropped here rather than being handled at the other end.
 */
export function buildServerLogQueryString(query: ServerLogQuery): string {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.minLevel) params.set("level", query.minLevel);
  const search = query.search?.trim();
  if (search) params.set("search", search);
  if (query.afterTimeMs !== undefined) params.set("afterTimeMs", String(query.afterTimeMs));
  if (query.deep) params.set("deep", "1");
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

/**
 * Plain statement of what a level filter includes, shown on the page.
 *
 * The filter is a threshold, not an exact match: picking warnings also shows
 * errors, because a filter that hid errors while claiming to show problems
 * would be actively dangerous. That is the right behaviour but it is not
 * guessable from a button labelled with a single level, so the page says it
 * outright rather than leaving it to be discovered.
 */
export function describeLevelFilter(minLevel: ServerLogLevel | "all"): string {
  switch (minLevel) {
    case "all":
      return "Showing every line, including debug detail.";
    case "info":
      return "Showing info, warnings and errors. Debug detail is hidden.";
    case "warn":
      return "Showing warnings and errors.";
    case "error":
      return "Showing errors only.";
    default:
      return `Showing ${minLevel} and above.`;
  }
}

/**
 * A key that identifies a log line by what it IS, not where it sits.
 *
 * `seq` is a position in one response, so it slides every time the poll returns
 * a window shifted by one line. Keying rows on it makes React reuse a row
 * component for a different log line, which carries that row's expanded state
 * onto whatever text lands in its place: a detail panel the operator opened
 * silently starts describing something else.
 */
export function logEntryKey(entry: {
  timeMs: number;
  level: string;
  msg: string;
  service: string | null;
}): string {
  return `${entry.timeMs}|${entry.level}|${entry.service ?? ""}|${entry.msg}`;
}

/** Clock time for a log row. The date is on the day divider, not every line. */
export function formatLogTime(timeMs: number): string {
  if (!Number.isFinite(timeMs) || timeMs <= 0) return "--:--:--";
  return new Date(timeMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** Day heading, so a page spanning midnight or a restart stays readable. */
export function formatLogDay(timeMs: number): string {
  if (!Number.isFinite(timeMs) || timeMs <= 0) return "Unknown date";
  return new Date(timeMs).toLocaleDateString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

export function logDayKey(timeMs: number): string {
  if (!Number.isFinite(timeMs) || timeMs <= 0) return "unknown";
  return new Date(timeMs).toDateString();
}

const LEVEL_TONE: Record<ServerLogLevel, string> = {
  trace: "text-muted-foreground",
  debug: "text-muted-foreground",
  info: "text-foreground",
  warn: "text-amber-600 dark:text-amber-500",
  error: "text-destructive",
  fatal: "text-destructive",
};

export function levelToneClass(level: ServerLogLevel): string {
  return LEVEL_TONE[level] ?? "text-foreground";
}

const LEVEL_BADGE: Record<ServerLogLevel, string> = {
  trace: "bg-muted text-muted-foreground",
  debug: "bg-muted text-muted-foreground",
  info: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
  warn: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  error: "bg-destructive/10 text-destructive",
  fatal: "bg-destructive/20 text-destructive",
};

export function levelBadgeClass(level: ServerLogLevel): string {
  return LEVEL_BADGE[level] ?? LEVEL_BADGE.info;
}
