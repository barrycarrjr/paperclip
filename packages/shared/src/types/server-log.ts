/**
 * The server's own log, as the Logs page reads it.
 *
 * The server writes two streams (see server/src/middleware/logger.ts): a
 * human-readable one to stdout, which the tray launcher captures into dated
 * files, and a size-capped rolling one in NDJSON - one JSON object per line -
 * which is what these types describe. The rolling stream is the one worth
 * reading in the app: it is structured, so it can be filtered and searched,
 * and it is capped, so it cannot grow without bound.
 */

/** Pino's numeric levels, named. */
export const SERVER_LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

export type ServerLogLevel = (typeof SERVER_LOG_LEVELS)[number];

/** The numeric level pino writes for each name. */
export const SERVER_LOG_LEVEL_VALUES: Record<ServerLogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export function serverLogLevelFromValue(value: number): ServerLogLevel {
  // Pino allows custom levels between the standard ones, so round down to the
  // nearest named level rather than only matching exact values.
  if (value >= 60) return "fatal";
  if (value >= 50) return "error";
  if (value >= 40) return "warn";
  if (value >= 30) return "info";
  if (value >= 20) return "debug";
  return "trace";
}

export interface ServerLogEntry {
  /**
   * Position of this line in the response, oldest first. Only meaningful
   * within one response - it is a React key and a stable sort, not an offset
   * into the file, which would be wrong the moment the log rolls.
   */
  seq: number;
  /** Milliseconds since the epoch, from pino's `time`. */
  timeMs: number;
  level: ServerLogLevel;
  /** The raw numeric level, kept so a custom level still sorts correctly. */
  levelValue: number;
  msg: string;
  /** pino child-logger name, where one was used (`service: "routines"`). */
  service: string | null;
  /**
   * Everything else on the line, with anything that looks like a credential
   * replaced. Shown when a row is expanded.
   */
  detail: Record<string, unknown>;
}

export interface ServerLogPage {
  /** Oldest first, so the newest line is the last one - the reading order. */
  entries: ServerLogEntry[];
  /**
   * True when the scan hit its byte budget before satisfying `limit`. Means
   * "there is more history than this, narrow the search", not "an error".
   */
  truncated: boolean;
  /** Files actually read, newest first. Empty when logging to file is off. */
  files: string[];
  /** Total bytes scanned, so the page can say how hard the search worked. */
  bytesScanned: number;
}

export interface ServerLogQuery {
  /** Maximum entries to return. */
  limit?: number;
  /** Lowest level to include. `warn` returns warn, error and fatal. */
  minLevel?: ServerLogLevel;
  /** Case-insensitive substring match over the message and the detail. */
  search?: string;
  /** Only entries strictly newer than this, for cheap polling. */
  afterTimeMs?: number;
}
