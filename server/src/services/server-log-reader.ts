import fs from "node:fs/promises";
import path from "node:path";
import {
  serverLogLevelFromValue,
  SERVER_LOG_LEVEL_VALUES,
  type ServerLogEntry,
  type ServerLogLevel,
  type ServerLogPage,
  type ServerLogQuery,
} from "@paperclipai/shared";
import { SERVER_LOG_FILE_PATTERN } from "../middleware/log-file-target.js";

/**
 * Reads the tail of the server's own rolling log for the Logs page.
 *
 * Everything here is built around one constraint: a log directory can contain
 * a file far larger than anything worth holding in memory. This instance has a
 * 682 MB `server.log` left over from before the size cap existed, so a reader
 * that opens a file and splits it is not merely slow, it exhausts the heap.
 * Every read is therefore bounded from the END of the file by an explicit byte
 * budget, and a request that exhausts the budget says so rather than
 * pretending it saw everything.
 */

/** Default entries per page. */
const DEFAULT_LIMIT = 200;
/** Ceiling on entries per page, to keep one response a sane size. */
export const MAX_LIMIT = 1000;
/**
 * Ceiling on bytes read per request, across all files. A filtered search may
 * legitimately have to scan a long way to find its matches; this is what stops
 * "search for a rare word" from reading 682 MB.
 */
export const MAX_BYTES_SCANNED = 32 * 1024 * 1024;
/** How many rolled files back a single request will walk. */
const MAX_FILES = 6;

/**
 * Roughly how many bytes one line takes, used to size the first read.
 *
 * Measured at about 250 bytes on a live instance; 1 KB leaves room for the
 * long ones so the common case is satisfied by a single read.
 */
const APPROX_BYTES_PER_LINE = 1024;
/** Floor on the first read, so a tiny limit still gets a useful window. */
const MIN_READ_WINDOW = 64 * 1024;
/** How much wider each retry gets when a window did not yield enough. */
const WINDOW_GROWTH = 4;

/** Fields pino puts on every line, surfaced as columns rather than detail. */
const STRUCTURAL_FIELDS = new Set(["level", "time", "pid", "hostname", "msg", "service", "name"]);

/**
 * Keys whose value is replaced wholesale. Matched loosely and case-insensitively
 * because the point is to catch credentials nobody thought about, and a false
 * positive costs one unreadable field while a false negative puts a live
 * credential on a screen.
 */
const SECRET_KEY_PATTERN =
  /(token|secret|password|passwd|api[-_]?key|authorization|credential|private[-_]?key|cookie|session[-_]?id|refresh)/i;

/**
 * Shapes that are a credential wherever they appear, including inside a message
 * or a field with an innocent name. Request bodies are logged on 4xx and 5xx
 * responses, so a mistyped token pasted into a form reaches the log by a route
 * no key-name rule would catch.
 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[baprse]-[A-Za-z0-9-]{10,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi,
  // JSON Web Tokens: three base64url segments. Session cookies and OAuth
  // access tokens both show up in this shape.
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

const REDACTED = "[redacted]";
/** Guards against a pathologically nested object costing unbounded work. */
const MAX_REDACT_DEPTH = 12;

export function redactSecretsInText(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

export function redactSecrets(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactSecretsInText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_REDACT_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactSecrets(item, depth + 1);
  }
  return out;
}

/**
 * One parsed NDJSON line, or null when the line is not a usable log record.
 *
 * Unparseable lines are dropped rather than surfaced. The first line of a
 * tail read is normally a partial one, and a crash can leave a half-written
 * line behind, so "this line is not JSON" is an expected condition here, not
 * an error worth reporting.
 */
export function parseServerLogLine(line: string, seq: number): ServerLogEntry | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("{")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  const levelValue = typeof record.level === "number" ? record.level : SERVER_LOG_LEVEL_VALUES.info;
  const timeMs = typeof record.time === "number" ? record.time : 0;
  const rawService = record.service ?? record.name;

  const detail: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (STRUCTURAL_FIELDS.has(key)) continue;
    detail[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactSecrets(value, 1);
  }

  return {
    seq,
    timeMs,
    level: serverLogLevelFromValue(levelValue),
    levelValue,
    msg: redactSecretsInText(typeof record.msg === "string" ? record.msg : ""),
    service: typeof rawService === "string" ? rawService : null,
    detail,
  };
}

/**
 * Rolling log files in a directory, newest first.
 *
 * Ordered by modification time rather than by the numeric suffix: pino-roll
 * counts upward, but the count restarts against whatever is already on disk,
 * so the highest number is not reliably the newest file. Modification time is.
 */
export async function listServerLogFiles(
  logDir: string,
): Promise<{ name: string; path: string; size: number; mtimeMs: number }[]> {
  let names: string[];
  try {
    names = await fs.readdir(logDir);
  } catch {
    // No log directory means logging to file is off, or nothing has been
    // written yet. Both are "no entries", not a failure.
    return [];
  }

  const files = await Promise.all(
    names
      .filter((name) => SERVER_LOG_FILE_PATTERN.test(name))
      .map(async (name) => {
        const filePath = path.join(logDir, name);
        try {
          const stat = await fs.stat(filePath);
          if (!stat.isFile()) return null;
          return { name, path: filePath, size: stat.size, mtimeMs: stat.mtimeMs };
        } catch {
          // Rotation can delete a file between readdir and stat.
          return null;
        }
      }),
  );

  return files
    .filter((file): file is NonNullable<typeof file> => file !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Reads at most `maxBytes` from the end of a file and returns its complete
 * lines, oldest first.
 *
 * A single read rather than a backwards chunk walk: the budget already bounds
 * how much is read, and one read means one UTF-8 decode, so there is no chunk
 * boundary that could split a multi-byte character. When the read did not
 * reach the start of the file its first line is a fragment, and is dropped.
 */
export async function readTailLines(
  filePath: string,
  maxBytes: number,
): Promise<{ lines: string[]; bytesRead: number; reachedStart: boolean }> {
  if (maxBytes <= 0) return { lines: [], bytesRead: 0, reachedStart: false };

  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const size = stat.size;
    if (size === 0) return { lines: [], bytesRead: 0, reachedStart: true };

    const readSize = Math.min(size, maxBytes);
    const start = size - readSize;
    const reachedStart = start === 0;

    // Read one byte before the window when there is one. That byte says whether
    // the window happens to begin exactly at a line start, which is the
    // difference between the first line being a fragment to discard and a whole
    // log line to keep. Dropping it unconditionally silently loses a real line
    // roughly once per average-line-length worth of offsets.
    const probeStart = reachedStart ? start : start - 1;
    const probeLength = readSize + (reachedStart ? 0 : 1);
    const buffer = Buffer.alloc(probeLength);
    const { bytesRead } = await handle.read(buffer, 0, probeLength, probeStart);

    let body = buffer.subarray(0, bytesRead);
    let firstLineIsWhole = true;
    if (!reachedStart && body.length > 0) {
      firstLineIsWhole = body[0] === 0x0a;
      body = body.subarray(1);
    }

    const lines = body.toString("utf8").split("\n");
    if (!firstLineIsWhole) lines.shift();

    return { lines, bytesRead: body.length, reachedStart };
  } finally {
    await handle.close();
  }
}

function matchesSearch(entry: ServerLogEntry, needle: string): boolean {
  if (entry.msg.toLowerCase().includes(needle)) return true;
  if (entry.service && entry.service.toLowerCase().includes(needle)) return true;
  try {
    return JSON.stringify(entry.detail).toLowerCase().includes(needle);
  } catch {
    return false;
  }
}

/**
 * The newest entries matching a query, oldest first.
 *
 * Walks the rolling files newest first and reads each one backwards from its
 * end, stopping as soon as `limit` matches are in hand or the byte budget runs
 * out. Returning oldest first is deliberate: it is the order the page renders,
 * and it means the newest line is the last one, where a log reader expects it.
 */
export async function readServerLogTail(
  logDir: string,
  query: ServerLogQuery = {},
): Promise<ServerLogPage> {
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const minLevelValue = query.minLevel ? SERVER_LOG_LEVEL_VALUES[query.minLevel] : 0;
  const needle = query.search?.trim().toLowerCase() ?? "";
  const afterTimeMs = query.afterTimeMs;

  const files = await listServerLogFiles(logDir);
  const collected: ServerLogEntry[] = [];
  const filesRead: string[] = [];
  let bytesScanned = 0;
  let truncated = false;

  for (const file of files.slice(0, MAX_FILES)) {
    if (collected.length >= limit) break;
    const fileBudget = MAX_BYTES_SCANNED - bytesScanned;
    if (fileBudget <= 0) {
      truncated = true;
      break;
    }

    // Start with a window sized to what `limit` plausibly needs and widen only
    // when it comes up short, rather than handing each file the whole budget.
    // Handing over the whole budget made an unfiltered 200-line page read 8 MB,
    // which at a two-second poll is megabytes a second of disk traffic to show
    // a screenful of text. A filter that matches nothing still walks out to the
    // budget, because that is the case where scanning far is the entire point.
    const needed = (limit - collected.length) * APPROX_BYTES_PER_LINE;
    let window = Math.min(Math.max(needed, MIN_READ_WINDOW), fileBudget);
    let read: Awaited<ReturnType<typeof readTailLines>> | null = null;
    let matches: ServerLogEntry[] = [];

    while (true) {
      try {
        read = await readTailLines(file.path, window);
      } catch {
        // A file can vanish under rotation mid-request.
        read = null;
        break;
      }

      // Newest line last in the file, so walk backwards: `limit` should be the
      // newest matches, not the oldest ones that happen to be in the window.
      matches = [];
      for (let i = read.lines.length - 1; i >= 0 && collected.length + matches.length < limit; i--) {
        const entry = parseServerLogLine(read.lines[i]!, 0);
        if (!entry) continue;
        if (entry.levelValue < minLevelValue) continue;
        if (afterTimeMs !== undefined && entry.timeMs <= afterTimeMs) continue;
        if (needle && !matchesSearch(entry, needle)) continue;
        matches.push(entry);
      }

      const enough = collected.length + matches.length >= limit;
      if (enough || read.reachedStart || window >= fileBudget) break;
      // Re-reads the tail rather than stitching chunks, so there is still only
      // one read and one UTF-8 decode per attempt and no boundary to split a
      // multi-byte character on. The wider read covers the narrower one, so
      // only the final window counts towards the budget.
      window = Math.min(window * WINDOW_GROWTH, fileBudget);
    }

    if (!read) continue;

    bytesScanned += read.bytesRead;
    filesRead.push(file.name);
    if (!read.reachedStart) truncated = true;
    collected.push(...matches);
  }

  if (collected.length >= limit && files.length > 0) {
    // Hit the ceiling, so there is almost certainly older history behind it.
    truncated = true;
  }

  // Collected newest first; the page wants oldest first.
  const entries = collected.reverse().map((entry, index) => ({ ...entry, seq: index }));

  return { entries, truncated, files: filesRead, bytesScanned };
}
