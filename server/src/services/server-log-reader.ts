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
export function parseServerLogRecord(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("{")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

export function serverLogLevelValueOf(record: Record<string, unknown>): number {
  return typeof record.level === "number" ? record.level : SERVER_LOG_LEVEL_VALUES.info;
}

export function serverLogTimeMsOf(record: Record<string, unknown>): number {
  return typeof record.time === "number" ? record.time : 0;
}

/**
 * Build the entry the client sees. This is where redaction happens, so it is
 * by far the most expensive step per line: a recursive walk plus seven global
 * regexes over every string. Callers that are going to reject a line on level
 * or time should do that first and never call this.
 */
export function buildServerLogEntry(
  record: Record<string, unknown>,
  seq: number,
): ServerLogEntry {
  const levelValue = serverLogLevelValueOf(record);
  const timeMs = serverLogTimeMsOf(record);
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

/** Parse and build in one step. Convenience for callers with no filtering. */
export function parseServerLogLine(line: string, seq: number): ServerLogEntry | null {
  const record = parseServerLogRecord(line);
  return record ? buildServerLogEntry(record, seq) : null;
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
  const deep = query.deep === true;

  const files = await listServerLogFiles(logDir);
  const collected: ServerLogEntry[] = [];
  const filesRead: string[] = [];
  let bytesScanned = 0;
  let truncated = false;

  for (const file of files.slice(0, MAX_FILES)) {
    if (collected.length >= limit) break;
    if (bytesScanned >= MAX_BYTES_SCANNED) {
      truncated = true;
      break;
    }

    // Start with a window sized to what `limit` plausibly needs, and widen only
    // on an explicit deep search. Widening on every request was the original
    // bug in two directions: unfiltered it read the whole budget for a
    // screenful, and filtered it kept widening to the ceiling whenever the
    // matches were sparse. The second one is worse, because a filtered request
    // repeats on the two-second refresh, so an ordinary search turns into tens
    // of megabytes read and hundreds of thousands of lines parsed every couple
    // of seconds indefinitely. Searching far is a thing the operator asks for,
    // not something a timer does.
    const needed = (limit - collected.length) * APPROX_BYTES_PER_LINE;
    let window = Math.max(needed, MIN_READ_WINDOW);
    let read: Awaited<ReturnType<typeof readTailLines>> | null = null;
    let matches: ServerLogEntry[] = [];
    let scannedThisFile = false;

    while (true) {
      const remaining = MAX_BYTES_SCANNED - bytesScanned;
      if (remaining <= 0) {
        truncated = true;
        break;
      }

      const attempt = Math.min(window, remaining);
      try {
        read = await readTailLines(file.path, attempt);
      } catch {
        // A file can vanish under rotation mid-request.
        read = null;
        break;
      }

      // Every read counts, including one superseded by a wider retry. The wider
      // read covers the same bytes, but the narrower one was still read,
      // decoded and parsed, and the budget exists to bound work done rather
      // than ground covered. Counting only the last read let a nominal 32 MB
      // ceiling actually read 55 MB.
      bytesScanned += read.bytesRead;
      scannedThisFile = true;

      // Newest line last in the file, so walk backwards: `limit` should be the
      // newest matches, not the oldest ones that happen to be in the window.
      matches = [];
      for (let i = read.lines.length - 1; i >= 0 && collected.length + matches.length < limit; i--) {
        const raw = read.lines[i]!;
        // Cheapest rejection first. A needle absent from the raw line cannot be
        // in the built entry, which only ever removes information, so this
        // skips the parse and the redaction walk entirely. The one divergence
        // is searching for the redaction marker itself, which is not a thing
        // worth paying for on every line.
        if (needle && !raw.toLowerCase().includes(needle)) continue;

        const record = parseServerLogRecord(raw);
        if (!record) continue;
        // Level and time before building, so a level filter does not pay the
        // redaction cost for every line it is about to discard.
        if (serverLogLevelValueOf(record) < minLevelValue) continue;
        const timeMs = serverLogTimeMsOf(record);
        if (afterTimeMs !== undefined && timeMs <= afterTimeMs) continue;

        const entry = buildServerLogEntry(record, 0);
        if (needle && !matchesSearch(entry, needle)) continue;
        matches.push(entry);
      }

      const enough = collected.length + matches.length >= limit;
      if (enough || read.reachedStart || !deep) break;
      if (attempt >= remaining) {
        truncated = true;
        break;
      }
      // Re-reads the tail rather than stitching chunks, so there is still only
      // one read and one UTF-8 decode per attempt and no chunk boundary that
      // could split a multi-byte character.
      window *= WINDOW_GROWTH;
    }

    if (!read || !scannedThisFile) continue;

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
