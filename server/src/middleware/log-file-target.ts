import path from "node:path";

/**
 * Rolling file target for the server log.
 *
 * Size-capped because the previous single-file target grew unbounded (it had
 * reached 680 MB): pino-roll writes `server.1.log`, `server.2.log`, ...,
 * rotating once a file exceeds `size` and deleting the oldest beyond
 * `limit.count`, so the log directory stays under ~100 MB total. Rolled files
 * hold raw NDJSON lines (pino-roll has no prettifier); the human-readable
 * pretty stream still goes to stdout via the other transport target in
 * logger.ts, which the tray launcher captures to its dated files.
 */
export function buildFileLogTarget(logDir: string): {
  target: string;
  level: string;
  options: {
    file: string;
    extension: string;
    size: string;
    limit: { count: number };
    mkdir: boolean;
    // Keeps this options shape assignable to pino's TransportOptions record
    // when it sits in the same targets array as the pino-pretty target.
    [key: string]: unknown;
  };
} {
  return {
    target: "pino-roll",
    level: "debug",
    options: {
      file: path.join(logDir, "server"),
      extension: ".log",
      size: "25m",
      limit: { count: 4 },
      mkdir: true,
    },
  };
}
