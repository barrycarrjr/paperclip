import type { UsageSummary } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  parseObject,
  parseJson,
} from "@paperclipai/adapter-utils/server-utils";

const CLAUDE_AUTH_REQUIRED_RE = /(?:not\s+logged\s+in|please\s+log\s+in|(?:please\s+)?run\s+`?claude\s+(?:auth\s+)?login`?|login\s+required|requires\s+login|unauthorized|authentication\s+required|authentication[_\s]error|failed\s+to\s+authenticate|invalid\s+authentication\s+credentials|invalid\s+x-api-key|invalid\s+bearer\s+token|oauth\s+token\s+(?:has\s+)?expired)/i;
const URL_RE = /(https?:\/\/[^\s'"`<>()[\]{};,!?]+[^\s'"`<>()[\]{};,!.?:]+)/gi;

/**
 * "The provider is busy" - worth retrying the same account shortly.
 *
 * Deliberately holds no subscription-window wording. Those phrases moved to
 * CLAUDE_PLAN_EXHAUSTED_RE, because a spent plan does not recover on a backoff
 * ladder and needs a different account instead.
 */
const CLAUDE_TRANSIENT_UPSTREAM_RE =
  /(?:rate[-\s]?limit(?:ed)?|rate_limit_error|too\s+many\s+requests|\b429\b|overloaded(?:_error)?|server\s+overloaded|service\s+unavailable|\b503\b|\b529\b|high\s+demand|try\s+again\s+later|temporarily\s+unavailable|throttl(?:ed|ing)|throttlingexception|servicequotaexceededexception)/i;

/**
 * "This subscription is spent" - the same account keeps failing until its
 * window resets.
 *
 * The first alternation is the wording the CLI actually uses today ("You've hit
 * your weekly limit - resets Aug 17, 3am"). The rest are older phrasings kept
 * so a CLI downgrade does not silently reclassify. This is only the fallback:
 * the structured rate_limit_event is preferred wherever it is present, because
 * prose wording has already drifted once.
 */
const CLAUDE_PLAN_EXHAUSTED_RE =
  /(?:you'?ve\s+hit\s+your\s+[^\n]{0,40}limit|out\s+of\s+extra\s+usage|extra\s+usage\b|claude\s+usage\s+limit\s+reached|5[-\s]?hour\s+limit\s+reached|weekly\s+limit\s+reached|usage\s+limit\s+reached|usage\s+cap\s+reached)/i;

const CLAUDE_EXTRA_USAGE_RESET_RE =
  /(?:you'?ve\s+hit\s+your\s+[^\n]{0,40}limit|out\s+of\s+extra\s+usage|extra\s+usage|usage\s+limit\s+reached|usage\s+cap\s+reached|5[-\s]?hour\s+limit\s+reached|weekly\s+limit\s+reached|claude\s+usage\s+limit\s+reached)[\s\S]{0,80}?\bresets?\s+(?:at\s+)?([^\n()]+?)(?:\s*\(([^)]+)\))?(?:[.!]|\n|$)/i;

/**
 * What the CLI reports on a `rate_limit_event` stream line.
 *
 * `status` is "allowed" | "warning" | "rejected"; only "rejected" means the
 * request was actually refused. `rateLimitType` names the window that ran out
 * ("seven_day", "five_hour"), which is the difference between waiting hours and
 * waiting days. `overageStatus` / `overageDisabledReason` say whether paid
 * overage could have covered it ("out_of_credits" means no).
 */
export interface ClaudeRateLimitInfo {
  status: string;
  resetsAt: Date | null;
  rateLimitType: string;
  overageStatus: string;
  overageDisabledReason: string;
}

/**
 * The CLI sends resetsAt as epoch SECONDS. Treat anything small enough to be a
 * plausible second-count as seconds and anything larger as milliseconds, so a
 * future switch to milliseconds does not silently produce a 1970 date.
 */
function resetsAtToDate(raw: unknown): Date | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  const ms = raw < 1e12 ? raw * 1000 : raw;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

function readRateLimitEvent(event: Record<string, unknown>): ClaudeRateLimitInfo | null {
  const info = parseObject(event.rate_limit_info);
  const status = asString(info.status, "").trim();
  if (!status) return null;
  return {
    status,
    resetsAt: resetsAtToDate(info.resetsAt),
    rateLimitType: asString(info.rateLimitType, "").trim(),
    overageStatus: asString(info.overageStatus, "").trim(),
    overageDisabledReason: asString(info.overageDisabledReason, "").trim(),
  };
}

export function parseClaudeStreamJson(stdout: string) {
  let sessionId: string | null = null;
  let model = "";
  let finalResult: Record<string, unknown> | null = null;
  let rateLimit: ClaudeRateLimitInfo | null = null;
  const assistantTexts: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "");
    if (type === "system" && asString(event.subtype, "") === "init") {
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
      model = asString(event.model, model);
      continue;
    }

    // The CLI announces a refused request on its own stream line, before the
    // failure it causes, and says exactly which window ran out and when it comes
    // back. That is worth strictly more than reading the prose afterwards, which
    // has already changed wording once. A run can carry several of these (a
    // "warning" as a window fills, then a "rejected"), so a rejection always wins
    // and, failing that, the last one seen stands.
    if (type === "rate_limit_event") {
      const info = readRateLimitEvent(event);
      if (info && (rateLimit?.status !== "rejected" || info.status === "rejected")) {
        rateLimit = info;
      }
      continue;
    }

    if (type === "assistant") {
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
      const message = parseObject(event.message);
      const content = Array.isArray(message.content) ? message.content : [];
      for (const entry of content) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
        const block = entry as Record<string, unknown>;
        if (asString(block.type, "") === "text") {
          const text = asString(block.text, "");
          if (text) assistantTexts.push(text);
        }
      }
      continue;
    }

    if (type === "result") {
      finalResult = event;
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
    }
  }

  if (!finalResult) {
    return {
      sessionId,
      model,
      costUsd: null as number | null,
      usage: null as UsageSummary | null,
      summary: assistantTexts.join("\n\n").trim(),
      resultJson: null as Record<string, unknown> | null,
      rateLimit,
    };
  }

  const usageObj = parseObject(finalResult.usage);
  const usage: UsageSummary = {
    inputTokens: asNumber(usageObj.input_tokens, 0),
    cachedInputTokens: asNumber(usageObj.cache_read_input_tokens, 0),
    outputTokens: asNumber(usageObj.output_tokens, 0),
  };
  const costRaw = finalResult.total_cost_usd;
  const costUsd = typeof costRaw === "number" && Number.isFinite(costRaw) ? costRaw : null;
  const summary = asString(finalResult.result, assistantTexts.join("\n\n")).trim();

  return {
    sessionId,
    model,
    costUsd,
    usage,
    summary,
    resultJson: finalResult,
    rateLimit,
  };
}

/** The rate-limit line the CLI emitted during this run, if any. */
export function extractClaudeRateLimitEvent(stdout: string | null | undefined): ClaudeRateLimitInfo | null {
  if (!stdout) return null;
  return parseClaudeStreamJson(stdout).rateLimit;
}

function extractClaudeErrorMessages(parsed: Record<string, unknown>): string[] {
  const raw = Array.isArray(parsed.errors) ? parsed.errors : [];
  const messages: string[] = [];

  for (const entry of raw) {
    if (typeof entry === "string") {
      const msg = entry.trim();
      if (msg) messages.push(msg);
      continue;
    }

    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }

    const obj = entry as Record<string, unknown>;
    const msg = asString(obj.message, "") || asString(obj.error, "") || asString(obj.code, "");
    if (msg) {
      messages.push(msg);
      continue;
    }

    try {
      messages.push(JSON.stringify(obj));
    } catch {
      // skip non-serializable entry
    }
  }

  return messages;
}

export function extractClaudeLoginUrl(text: string): string | null {
  const match = text.match(URL_RE);
  if (!match || match.length === 0) return null;
  for (const rawUrl of match) {
    const cleaned = rawUrl.replace(/[\])}.!,?;:'\"]+$/g, "");
    if (cleaned.includes("claude") || cleaned.includes("anthropic") || cleaned.includes("auth")) {
      return cleaned;
    }
  }
  return match[0]?.replace(/[\])}.!,?;:'\"]+$/g, "") ?? null;
}

export function detectClaudeLoginRequired(input: {
  parsed: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
}): { requiresLogin: boolean; loginUrl: string | null } {
  const resultText = asString(input.parsed?.result, "").trim();
  const messages = [resultText, ...extractClaudeErrorMessages(input.parsed ?? {}), input.stdout, input.stderr]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  // A 401 from the CLI is always an authentication failure (expired/revoked
  // OAuth session, or a missing/invalid API key) — never a rate-limit or a
  // transient upstream blip. Key off the structured status code in addition to
  // the prose, because the human-readable wording has drifted across CLI
  // versions ("Invalid authentication credentials" matches no legacy phrase).
  const apiErrorStatus = asNumber(input.parsed?.api_error_status, 0);
  const requiresLogin =
    apiErrorStatus === 401 || messages.some((line) => CLAUDE_AUTH_REQUIRED_RE.test(line));
  return {
    requiresLogin,
    loginUrl: extractClaudeLoginUrl([input.stdout, input.stderr].join("\n")),
  };
}

export function describeClaudeFailure(parsed: Record<string, unknown>): string | null {
  const subtype = asString(parsed.subtype, "");
  const resultText = asString(parsed.result, "").trim();
  const errors = extractClaudeErrorMessages(parsed);

  let detail = resultText;
  if (!detail && errors.length > 0) {
    detail = errors[0] ?? "";
  }

  const parts = ["Claude run failed"];
  if (subtype) parts.push(`subtype=${subtype}`);
  if (detail) parts.push(detail);
  return parts.length > 1 ? parts.join(": ") : null;
}

export function isClaudeMaxTurnsResult(parsed: Record<string, unknown> | null | undefined): boolean {
  if (!parsed) return false;

  const subtype = asString(parsed.subtype, "").trim().toLowerCase();
  if (subtype === "error_max_turns") return true;

  const stopReason = asString(parsed.stop_reason, "").trim().toLowerCase();
  if (stopReason === "max_turns") return true;

  const resultText = asString(parsed.result, "").trim();
  return /max(?:imum)?\s+turns?/i.test(resultText);
}

export function isClaudeUnknownSessionError(parsed: Record<string, unknown>): boolean {
  const resultText = asString(parsed.result, "").trim();
  const allMessages = [resultText, ...extractClaudeErrorMessages(parsed)]
    .map((msg) => msg.trim())
    .filter(Boolean);

  return allMessages.some((msg) =>
    /no conversation found with session id|unknown session|session .* not found/i.test(msg),
  );
}

/**
 * Drop the CLI's own rate-limit lines before the prose is pattern-matched.
 *
 * Those lines are read structurally now, and leaving them in the haystack makes
 * every one of them match the transient pattern by accident: the field name
 * `rateLimitType` contains the literal text "rateLimit". That turns any failed
 * run which merely mentioned a limit - including a purely informational
 * "allowed" event - into a transient failure worth four retries. Removing the
 * lines loses nothing, because their contents are already parsed properly.
 */
function stripRateLimitEventLines(stdout: string): string {
  if (!stdout.includes("rate_limit_event")) return stdout;
  return stdout
    .split(/\r?\n/)
    .filter((line) => {
      if (!line.includes("rate_limit_event")) return true;
      const event = parseJson(line.trim());
      return !event || asString(event.type, "") !== "rate_limit_event";
    })
    .join("\n");
}

function buildClaudeTransientHaystack(input: {
  parsed?: Record<string, unknown> | null;
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): string {
  const parsed = input.parsed ?? null;
  const resultText = parsed ? asString(parsed.result, "") : "";
  const parsedErrors = parsed ? extractClaudeErrorMessages(parsed) : [];
  return [
    input.errorMessage ?? "",
    resultText,
    ...parsedErrors,
    stripRateLimitEventLines(input.stdout ?? ""),
    input.stderr ?? "",
  ]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function readTimeZoneParts(date: Date, timeZone: string) {
  const values = new Map(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(date).map((part) => [part.type, part.value]),
  );
  return {
    year: Number.parseInt(values.get("year") ?? "", 10),
    month: Number.parseInt(values.get("month") ?? "", 10),
    day: Number.parseInt(values.get("day") ?? "", 10),
    hour: Number.parseInt(values.get("hour") ?? "", 10),
    minute: Number.parseInt(values.get("minute") ?? "", 10),
  };
}

function normalizeResetTimeZone(timeZoneHint: string | null | undefined): string | null {
  const normalized = timeZoneHint?.trim();
  if (!normalized) return null;
  if (/^(?:utc|gmt)$/i.test(normalized)) return "UTC";

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date(0));
    return normalized;
  } catch {
    return null;
  }
}

function dateFromTimeZoneWallClock(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZone: string;
}): Date | null {
  let candidate = new Date(Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0));
  const targetUtc = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = readTimeZoneParts(candidate, input.timeZone);
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0, 0);
    const offsetMs = targetUtc - actualUtc;
    if (offsetMs === 0) break;
    candidate = new Date(candidate.getTime() + offsetMs);
  }

  const verified = readTimeZoneParts(candidate, input.timeZone);
  if (
    verified.year !== input.year ||
    verified.month !== input.month ||
    verified.day !== input.day ||
    verified.hour !== input.hour ||
    verified.minute !== input.minute
  ) {
    return null;
  }

  return candidate;
}

function nextClockTimeInTimeZone(input: {
  now: Date;
  hour: number;
  minute: number;
  timeZoneHint: string;
}): Date | null {
  const timeZone = normalizeResetTimeZone(input.timeZoneHint);
  if (!timeZone) return null;

  const nowParts = readTimeZoneParts(input.now, timeZone);
  let retryAt = dateFromTimeZoneWallClock({
    year: nowParts.year,
    month: nowParts.month,
    day: nowParts.day,
    hour: input.hour,
    minute: input.minute,
    timeZone,
  });
  if (!retryAt) return null;

  if (retryAt.getTime() <= input.now.getTime()) {
    const nextDay = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + 1, 0, 0, 0, 0));
    retryAt = dateFromTimeZoneWallClock({
      year: nextDay.getUTCFullYear(),
      month: nextDay.getUTCMonth() + 1,
      day: nextDay.getUTCDate(),
      hour: input.hour,
      minute: input.minute,
      timeZone,
    });
  }

  return retryAt;
}

function parseClaudeResetClockTime(clockText: string, now: Date, timeZoneHint?: string | null): Date | null {
  const normalized = clockText.trim().replace(/\s+/g, " ");
  const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/i);
  if (!match) return null;

  const hour12 = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "0", 10);
  if (!Number.isInteger(hour12) || hour12 < 1 || hour12 > 12) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  let hour24 = hour12 % 12;
  if ((match[3] ?? "").toLowerCase() === "p") hour24 += 12;

  if (timeZoneHint) {
    const explicitRetryAt = nextClockTimeInTimeZone({
      now,
      hour: hour24,
      minute,
      timeZoneHint,
    });
    if (explicitRetryAt) return explicitRetryAt;
  }

  const retryAt = new Date(now);
  retryAt.setHours(hour24, minute, 0, 0);
  if (retryAt.getTime() <= now.getTime()) {
    retryAt.setDate(retryAt.getDate() + 1);
  }
  return retryAt;
}

export interface ClaudeFailureInput {
  parsed?: Record<string, unknown> | null;
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
  /**
   * Pre-extracted rate-limit line, when the caller already walked the stream.
   * Omit it and the stdout is walked again.
   */
  rateLimit?: ClaudeRateLimitInfo | null;
}

export type ClaudeFailureClassification =
  | { family: "plan_exhausted"; resetsAt: Date | null; window: string | null }
  | { family: "transient_upstream"; retryNotBefore: Date | null }
  | null;

/**
 * Decide how a failed Claude run should be recovered from.
 *
 * The order of the checks is the substance of this function, not an
 * implementation detail. A refused-for-the-week run carries BOTH the plan
 * wording and a bare 429 (in `api_error_status`, and in the raw stdout the
 * haystack includes), so whichever test runs first decides the answer. Asking
 * "is it transient?" first is how a spent weekly plan ends up on a
 * two-minute backoff ladder, which is what this ordering exists to prevent.
 *
 * Deterministic failures (login required, max turns, an unknown session) are
 * somebody else's problem and return null, exactly as before.
 */
export function classifyClaudeFailure(
  input: ClaudeFailureInput,
  now = new Date(),
): ClaudeFailureClassification {
  const parsed = input.parsed ?? null;
  if (parsed && (isClaudeMaxTurnsResult(parsed) || isClaudeUnknownSessionError(parsed))) {
    return null;
  }
  const loginMeta = detectClaudeLoginRequired({
    parsed,
    stdout: input.stdout ?? "",
    stderr: input.stderr ?? "",
  });
  if (loginMeta.requiresLogin) return null;

  const rateLimit =
    input.rateLimit !== undefined ? input.rateLimit : extractClaudeRateLimitEvent(input.stdout);
  if (rateLimit?.status === "rejected") {
    return {
      family: "plan_exhausted",
      resetsAt: rateLimit.resetsAt,
      window: rateLimit.rateLimitType || null,
    };
  }

  const haystack = buildClaudeTransientHaystack(input);
  if (!haystack) return null;

  if (CLAUDE_PLAN_EXHAUSTED_RE.test(haystack)) {
    return {
      family: "plan_exhausted",
      resetsAt: matchClaudeResetHint(haystack, now),
      window: rateLimit?.rateLimitType || null,
    };
  }

  if (CLAUDE_TRANSIENT_UPSTREAM_RE.test(haystack)) {
    return { family: "transient_upstream", retryNotBefore: matchClaudeResetHint(haystack, now) };
  }

  return null;
}

/**
 * The reset time as written in the prose, when there is one.
 *
 * Strictly weaker than the structured `resetsAt`: this understands a clock time
 * and rolls forward at most one day, so it cannot express "Aug 17" at all. For
 * a weekly window it therefore lands early, the retry fails once more, and the
 * run reschedules. Wrong but safe, and only reached when the structured event
 * is absent.
 */
function matchClaudeResetHint(haystack: string, now: Date): Date | null {
  const match = haystack.match(CLAUDE_EXTRA_USAGE_RESET_RE);
  if (!match) return null;
  return parseClaudeResetClockTime(match[1] ?? "", now, match[2]);
}

export function extractClaudeRetryNotBefore(input: ClaudeFailureInput, now = new Date()): Date | null {
  const classification = classifyClaudeFailure(input, now);
  if (!classification) return null;
  return classification.family === "plan_exhausted"
    ? classification.resetsAt
    : classification.retryNotBefore;
}

export function isClaudeTransientUpstreamError(input: ClaudeFailureInput): boolean {
  return classifyClaudeFailure(input)?.family === "transient_upstream";
}

export function isClaudePlanExhaustedError(input: ClaudeFailureInput): boolean {
  return classifyClaudeFailure(input)?.family === "plan_exhausted";
}
