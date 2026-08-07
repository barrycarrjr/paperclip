const DEFAULT_RECENT_LOG_LIMIT = 40;
const RECENT_LOG_SUMMARY_LINES = 8;

function toError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) return error;
  if (error === undefined) return new Error(fallbackMessage);
  if (typeof error === "string") return new Error(`${fallbackMessage}: ${error}`);

  try {
    return new Error(`${fallbackMessage}: ${JSON.stringify(error)}`);
  } catch {
    return new Error(`${fallbackMessage}: ${String(error)}`);
  }
}

function summarizeRecentLogs(recentLogs: string[]): string | null {
  if (recentLogs.length === 0) return null;
  return recentLogs
    .slice(-RECENT_LOG_SUMMARY_LINES)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" | ");
}

function detectEmbeddedPostgresHint(recentLogs: string[]): string | null {
  const haystack = recentLogs.join("\n").toLowerCase();
  if (!haystack.includes("could not create shared memory segment")) {
    return null;
  }

  return (
    "Embedded PostgreSQL bootstrap could not allocate shared memory. " +
    "On macOS, this usually means the host's kern.sysv.shm* limits are too low for another local PostgreSQL cluster. " +
    "Stop other local PostgreSQL servers or raise the shared-memory sysctls, then retry."
  );
}

/**
 * Phrases postgres uses when a previous cluster's processes are still holding
 * this data directory's shared memory. Its own advice is "terminate any old
 * server processes", which is precisely what the caller does before retrying.
 */
const STALE_CLUSTER_PHRASES = [
  "pre-existing shared memory block is still in use",
  "terminate any old server processes",
] as const;

/**
 * Did this start fail because leftovers from the last run are still alive?
 *
 * Kept narrow on purpose. Killing processes is not something to do on a guess,
 * so only the shared-memory conflict counts - not a port clash, not a corrupt
 * cluster, not a permissions problem, all of which want a human rather than a
 * retry.
 */
export function isStaleEmbeddedPostgresCluster(
  error: unknown,
  recentLogs: readonly string[] = [],
): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const haystack = [message, ...recentLogs].join("\n").toLowerCase();
  return STALE_CLUSTER_PHRASES.some((phrase) => haystack.includes(phrase));
}

export function createEmbeddedPostgresLogBuffer(limit = DEFAULT_RECENT_LOG_LIMIT): {
  append(message: unknown): void;
  getRecentLogs(): string[];
} {
  const recentLogs: string[] = [];

  return {
    append(message: unknown) {
      const text =
        typeof message === "string"
          ? message
          : message instanceof Error
            ? message.message
            : String(message ?? "");

      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        recentLogs.push(line);
        if (recentLogs.length > limit) {
          recentLogs.splice(0, recentLogs.length - limit);
        }
      }
    },
    getRecentLogs() {
      return [...recentLogs];
    },
  };
}

export function formatEmbeddedPostgresError(
  error: unknown,
  input: {
    fallbackMessage: string;
    recentLogs?: string[];
  },
): Error {
  const baseError = toError(error, input.fallbackMessage);
  const recentLogs = input.recentLogs ?? [];
  const parts = [baseError.message];
  const hint = detectEmbeddedPostgresHint(recentLogs);
  const recentSummary = summarizeRecentLogs(recentLogs);

  if (hint) {
    parts.push(hint);
  }
  if (recentSummary) {
    parts.push(`Recent embedded Postgres logs: ${recentSummary}`);
  }

  return new Error(parts.join(" "));
}
