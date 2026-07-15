/**
 * Lightweight cron expression parser and next-run calculator.
 *
 * Supports standard 5-field cron expressions:
 *
 *   ┌────────────── minute (0–59)
 *   │ ┌──────────── hour   (0–23)
 *   │ │ ┌────────── day of month (1–31)
 *   │ │ │ ┌──────── month  (1–12)
 *   │ │ │ │ ┌────── day of week (0–6, Sun=0)
 *   │ │ │ │ │
 *   * * * * *
 *
 * Supported syntax per field:
 *   - `*`        — any value
 *   - `N`        — exact value
 *   - `N-M`      — range (inclusive)
 *   - `N/S`      — start at N, step S (within field bounds)
 *   - `* /S`     — every S (from field min)   [no space — shown to avoid comment termination]
 *   - `N-M/S`    — range with step
 *   - `N,M,...`  — list of values, ranges, or steps
 *
 * @module
 */

import { unprocessable } from "../errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A parsed cron schedule. Each field is a sorted array of valid integer values
 * for that field.
 */
export interface ParsedCron {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
}

// ---------------------------------------------------------------------------
// Field bounds
// ---------------------------------------------------------------------------

interface FieldSpec {
  min: number;
  max: number;
  name: string;
}

const FIELD_SPECS: FieldSpec[] = [
  { min: 0, max: 59, name: "minute" },
  { min: 0, max: 23, name: "hour" },
  { min: 1, max: 31, name: "day of month" },
  { min: 1, max: 12, name: "month" },
  { min: 0, max: 6, name: "day of week" },
];

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a single cron field token (e.g. `"5"`, `"1-3"`, `"* /10"`, `"1,3,5"`).
 *
 * @returns Sorted deduplicated array of matching integer values within bounds.
 * @throws {Error} on invalid syntax or out-of-range values.
 */
function parseField(token: string, spec: FieldSpec): number[] {
  const values = new Set<number>();

  // Split on commas first — each part can be a value, range, or step
  const parts = token.split(",");

  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === "") {
      throw new Error(`Empty element in cron ${spec.name} field`);
    }

    // Check for step syntax: "X/S" where X is "*" or a range or a number
    const slashIdx = trimmed.indexOf("/");
    if (slashIdx !== -1) {
      const base = trimmed.slice(0, slashIdx);
      const stepStr = trimmed.slice(slashIdx + 1);
      const step = parseInt(stepStr, 10);
      if (isNaN(step) || step <= 0) {
        throw new Error(
          `Invalid step "${stepStr}" in cron ${spec.name} field`,
        );
      }

      let rangeStart = spec.min;
      let rangeEnd = spec.max;

      if (base === "*") {
        // */S — every S from field min
      } else if (base.includes("-")) {
        // N-M/S — range with step
        const [a, b] = base.split("-").map((s) => parseInt(s, 10));
        if (isNaN(a!) || isNaN(b!)) {
          throw new Error(
            `Invalid range "${base}" in cron ${spec.name} field`,
          );
        }
        rangeStart = a!;
        rangeEnd = b!;
      } else {
        // N/S — start at N, step S
        const start = parseInt(base, 10);
        if (isNaN(start)) {
          throw new Error(
            `Invalid start "${base}" in cron ${spec.name} field`,
          );
        }
        rangeStart = start;
      }

      validateBounds(rangeStart, spec);
      validateBounds(rangeEnd, spec);

      for (let i = rangeStart; i <= rangeEnd; i += step) {
        values.add(i);
      }
      continue;
    }

    // Check for range syntax: "N-M"
    if (trimmed.includes("-")) {
      const [aStr, bStr] = trimmed.split("-");
      const a = parseInt(aStr!, 10);
      const b = parseInt(bStr!, 10);
      if (isNaN(a) || isNaN(b)) {
        throw new Error(
          `Invalid range "${trimmed}" in cron ${spec.name} field`,
        );
      }
      validateBounds(a, spec);
      validateBounds(b, spec);
      if (a > b) {
        throw new Error(
          `Invalid range ${a}-${b} in cron ${spec.name} field (start > end)`,
        );
      }
      for (let i = a; i <= b; i++) {
        values.add(i);
      }
      continue;
    }

    // Wildcard
    if (trimmed === "*") {
      for (let i = spec.min; i <= spec.max; i++) {
        values.add(i);
      }
      continue;
    }

    // Single value
    const val = parseInt(trimmed, 10);
    if (isNaN(val)) {
      throw new Error(
        `Invalid value "${trimmed}" in cron ${spec.name} field`,
      );
    }
    validateBounds(val, spec);
    values.add(val);
  }

  if (values.size === 0) {
    throw new Error(`Empty result for cron ${spec.name} field`);
  }

  return [...values].sort((a, b) => a - b);
}

function validateBounds(value: number, spec: FieldSpec): void {
  if (value < spec.min || value > spec.max) {
    throw new Error(
      `Value ${value} out of range [${spec.min}–${spec.max}] for cron ${spec.name} field`,
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a cron expression string into a structured {@link ParsedCron}.
 *
 * @param expression — A standard 5-field cron expression.
 * @returns Parsed cron with sorted valid values for each field.
 * @throws {Error} on invalid syntax.
 *
 * @example
 * ```ts
 * const parsed = parseCron("0 * * * *"); // every hour at minute 0
 * // parsed.minutes === [0]
 * // parsed.hours === [0,1,2,...,23]
 * ```
 */
export function parseCron(expression: string): ParsedCron {
  const trimmed = expression.trim();
  if (!trimmed) {
    throw new Error("Cron expression must not be empty");
  }

  const tokens = trimmed.split(/\s+/);
  if (tokens.length !== 5) {
    throw new Error(
      `Cron expression must have exactly 5 fields, got ${tokens.length}: "${trimmed}"`,
    );
  }

  return {
    minutes: parseField(tokens[0]!, FIELD_SPECS[0]!),
    hours: parseField(tokens[1]!, FIELD_SPECS[1]!),
    daysOfMonth: parseField(tokens[2]!, FIELD_SPECS[2]!),
    months: parseField(tokens[3]!, FIELD_SPECS[3]!),
    daysOfWeek: parseField(tokens[4]!, FIELD_SPECS[4]!),
  };
}

/**
 * Validate a cron expression string. Returns `null` if valid, or an error
 * message string if invalid.
 *
 * @param expression — A cron expression string to validate.
 * @returns `null` on success, error message on failure.
 */
export function validateCron(expression: string): string | null {
  try {
    parseCron(expression);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Calculate the next run time after `after` for the given parsed cron schedule.
 *
 * Starts from the minute immediately following `after` and walks forward
 * until a matching minute is found (up to a safety limit of ~4 years to
 * prevent infinite loops on impossible schedules).
 *
 * @param cron  — Parsed cron schedule.
 * @param after — The reference date. The returned date will be strictly after this.
 * @returns The next matching `Date`, or `null` if no match found within the search window.
 */
export function nextCronTick(cron: ParsedCron, after: Date): Date | null {
  // Work in local minutes — start from the minute after `after`
  const d = new Date(after.getTime());
  // Advance to the next whole minute
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1);

  // Safety: search up to 4 years worth of minutes (~2.1M iterations max).
  // Uses 366 to account for leap years.
  const MAX_CRON_SEARCH_YEARS = 4;
  const maxIterations = MAX_CRON_SEARCH_YEARS * 366 * 24 * 60;

  for (let i = 0; i < maxIterations; i++) {
    const month = d.getUTCMonth() + 1; // 1-12
    const dayOfMonth = d.getUTCDate(); // 1-31
    const dayOfWeek = d.getUTCDay(); // 0-6
    const hour = d.getUTCHours(); // 0-23
    const minute = d.getUTCMinutes(); // 0-59

    // Check month
    if (!cron.months.includes(month)) {
      // Skip to the first day of the next matching month
      advanceToNextMonth(d, cron.months);
      continue;
    }

    // Check day of month AND day of week (both must match)
    if (!cron.daysOfMonth.includes(dayOfMonth) || !cron.daysOfWeek.includes(dayOfWeek)) {
      // Advance one day
      d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(0, 0, 0, 0);
      continue;
    }

    // Check hour
    if (!cron.hours.includes(hour)) {
      // Advance to next matching hour within the day
      const nextHour = findNext(cron.hours, hour);
      if (nextHour !== null) {
        d.setUTCHours(nextHour, 0, 0, 0);
      } else {
        // No matching hour left today — advance to next day
        d.setUTCDate(d.getUTCDate() + 1);
        d.setUTCHours(0, 0, 0, 0);
      }
      continue;
    }

    // Check minute
    if (!cron.minutes.includes(minute)) {
      const nextMin = findNext(cron.minutes, minute);
      if (nextMin !== null) {
        d.setUTCMinutes(nextMin, 0, 0);
      } else {
        // No matching minute left this hour — advance to next hour
        d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0);
      }
      continue;
    }

    // All fields match!
    return new Date(d.getTime());
  }

  // No match found within the search window
  return null;
}

/**
 * Convenience: parse a cron expression and compute the next run time.
 *
 * @param expression — 5-field cron expression string.
 * @param after — Reference date (defaults to `new Date()`).
 * @returns The next matching Date, or `null` if no match within 4 years.
 * @throws {Error} if the cron expression is invalid.
 */
export function nextCronTickFromExpression(
  expression: string,
  after: Date = new Date(),
): Date | null {
  const cron = parseCron(expression);
  return nextCronTick(cron, after);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Find the next value in `sortedValues` that is greater than `current`.
 * Returns `null` if no such value exists.
 */
function findNext(sortedValues: number[], current: number): number | null {
  for (const v of sortedValues) {
    if (v > current) return v;
  }
  return null;
}

/**
 * Advance `d` (mutated in place) to midnight UTC of the first day of the next
 * month whose 1-based month number is in `months`.
 */
function advanceToNextMonth(d: Date, months: number[]): void {
  let year = d.getUTCFullYear();
  let month = d.getUTCMonth() + 1; // 1-based

  // Walk months forward until we find one in the set (max 48 iterations = 4 years)
  for (let i = 0; i < 48; i++) {
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
    if (months.includes(month)) {
      d.setUTCFullYear(year, month - 1, 1);
      d.setUTCHours(0, 0, 0, 0);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Timezone-aware helpers (shared by routines + calendar scheduling)
// ---------------------------------------------------------------------------

/**
 * Maps the short English weekday names produced by `Intl.DateTimeFormat`
 * (`weekday: "short"`) to their 0-based index (Sun=0 … Sat=6), matching
 * `Date.getUTCDay()` and the cron day-of-week field.
 */
export const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Validate that `timeZone` is an IANA identifier the runtime understands.
 * Throws an HTTP 422 error (matching the routines service behavior) on failure.
 */
export function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    throw unprocessable(`Invalid timezone: ${timeZone}`);
  }
}

/**
 * Return a copy of `date` with seconds and milliseconds zeroed (floored to the
 * start of its UTC minute).
 */
export function floorToMinute(date: Date): Date {
  const copy = new Date(date.getTime());
  copy.setUTCSeconds(0, 0);
  return copy;
}

/**
 * The civil (wall-clock) parts of a UTC instant, as seen in `timeZone`.
 * `month` is 1-based (1–12); `weekday` is 0-based (Sun=0 … Sat=6).
 */
export interface ZonedMinuteParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

/**
 * Break a UTC `date` into its civil (wall-clock) minute parts in `timeZone`.
 */
export function getZonedMinuteParts(date: Date, timeZone: string): ZonedMinuteParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  });
  const parts = formatter.formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekday = WEEKDAY_INDEX[map.weekday ?? ""];
  if (weekday == null) {
    throw new Error(`Unable to resolve weekday for timezone ${timeZone}`);
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    weekday,
  };
}

/**
 * Convenience alias: the civil (wall-clock) parts of a UTC instant in `timeZone`.
 * Thin wrapper over {@link getZonedMinuteParts}.
 */
export function utcToCivilParts(date: Date, timeZone: string): ZonedMinuteParts {
  return getZonedMinuteParts(date, timeZone);
}

/**
 * Does the civil minute of `date` (in `timeZone`) satisfy `expression`?
 */
export function matchesCronMinute(expression: string, timeZone: string, date: Date): boolean {
  const cron = parseCron(expression);
  const parts = getZonedMinuteParts(date, timeZone);
  return (
    cron.minutes.includes(parts.minute) &&
    cron.hours.includes(parts.hour) &&
    cron.daysOfMonth.includes(parts.day) &&
    cron.months.includes(parts.month) &&
    cron.daysOfWeek.includes(parts.weekday)
  );
}

/**
 * The next UTC instant strictly after `after` whose civil minute in `timeZone`
 * matches `expression`. Returns `null` if none is found within ~5 years.
 *
 * Unlike {@link nextCronTick}, this evaluates the cron fields against the
 * wall-clock time in `timeZone`, so it is daylight-saving aware.
 *
 * @throws {HttpError} 422 if the timezone or cron expression is invalid.
 */
export function nextCronTickInTimeZone(
  expression: string,
  timeZone: string,
  after: Date,
): Date | null {
  const trimmed = expression.trim();
  assertTimeZone(timeZone);
  const error = validateCron(trimmed);
  if (error) {
    throw unprocessable(error);
  }

  const cursor = floorToMinute(after);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  const limit = 366 * 24 * 60 * 5;
  for (let i = 0; i < limit; i += 1) {
    if (matchesCronMinute(trimmed, timeZone, cursor)) {
      return new Date(cursor.getTime());
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}

/**
 * Convert a civil/wall-clock date-time in `timeZone` to the corresponding UTC
 * `Date`. Uses a robust two-pass offset inversion so DST boundaries resolve
 * correctly (the inverse of {@link getZonedMinuteParts}).
 *
 * @param year   Full civil year (e.g. 2026).
 * @param month  Civil month, 1-based (1–12).
 * @param day    Civil day of month (1–31).
 * @param hour   Civil hour (0–23).
 * @param minute Civil minute (0–59).
 */
export function civilToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  assertTimeZone(timeZone);
  // Pass 1: treat the wall-clock as if it were UTC, then measure the tz offset AT that guess.
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const p1 = getZonedMinuteParts(new Date(guess), timeZone);
  const asIfUtc1 = Date.UTC(p1.year, p1.month - 1, p1.day, p1.hour, p1.minute);
  const offset1 = asIfUtc1 - guess; // ms the zone is ahead of UTC at the guess
  let utc = guess - offset1;
  // Pass 2: re-measure at the corrected instant to settle DST transitions.
  const p2 = getZonedMinuteParts(new Date(utc), timeZone);
  const asIfUtc2 = Date.UTC(p2.year, p2.month - 1, p2.day, p2.hour, p2.minute);
  const offset2 = asIfUtc2 - utc;
  if (offset2 !== offset1) {
    utc = guess - offset2;
  }
  return new Date(utc);
}
