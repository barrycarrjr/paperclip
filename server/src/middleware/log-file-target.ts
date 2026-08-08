import path from "node:path";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";

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
/**
 * Base name pino-roll writes, without the numeric suffix or extension. Shared
 * with the reader behind the Logs page so the two cannot drift apart: the
 * reader matches `server.<n>.log` and nothing else, which also keeps it from
 * picking up the launcher's `paperclip-<date>.log` files if the two streams
 * are ever pointed at the same directory.
 */
export const SERVER_LOG_BASENAME = "server";
export const SERVER_LOG_EXTENSION = ".log";

/** Matches `server.log` and `server.1.log`, `server.2.log`, ... */
export const SERVER_LOG_FILE_PATTERN = new RegExp(
  `^${SERVER_LOG_BASENAME}(\\.\\d+)?\\${SERVER_LOG_EXTENSION}$`,
);

/**
 * Where the rolling log is written, honouring the same overrides the rest of
 * the instance uses.
 *
 * Lives here rather than in logger.ts so the Logs route can ask where the log
 * is without importing logger.ts, which builds the pino transport as a side
 * effect of being imported.
 */
export function resolveServerLogDir(): string {
  const envOverride = process.env.PAPERCLIP_LOG_DIR?.trim();
  if (envOverride) return resolveHomeAwarePath(envOverride);

  const fileLogDir = readConfigFile()?.logging.logDir?.trim();
  if (fileLogDir) return resolveHomeAwarePath(fileLogDir);

  return resolveDefaultLogsDir();
}

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
      file: path.join(logDir, SERVER_LOG_BASENAME),
      extension: SERVER_LOG_EXTENSION,
      size: "25m",
      limit: { count: 4 },
      mkdir: true,
    },
  };
}
