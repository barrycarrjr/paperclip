/**
 * Pure schedule/occurrence engine for calendar events.
 *
 * Given a calendar event's scheduling fields, compute:
 *   - {@link computeNextRun}: the next reminder ("notify") instant after a
 *     reference time (occurrence instant minus lead time), and
 *   - {@link expandOccurrences}: all occurrence instants within a window, for
 *     calendar rendering.
 *
 * This module is intentionally free of side effects (no DB, no IO, no logging).
 * It relies only on the shared, DST-correct timezone helpers in {@link ./cron}.
 * Interval cadences are computed on a civil (wall-clock) date sequence at a
 * fixed local time-of-day, so an event at 09:00 local stays 09:00 local across
 * daylight-saving transitions even though its UTC instant shifts.
 *
 * @module
 */

import { civilToUtc, getZonedMinuteParts, nextCronTickInTimeZone } from "./cron.js";

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

export interface CalendarScheduleInput {
  scheduleKind: "once" | "interval" | "cron";
  anchorAt: Date | string | null;
  intervalUnit: "day" | "week" | "month" | null;
  intervalCount: number | null;
  timeOfDay: string | null; // 'HH:MM'
  cronExpression: string | null;
  timezone: string; // IANA
  endAt: Date | string | null;
  maxOccurrences: number | null;
  leadTimeMinutes: number; // >= 0
}

export interface ExpandResult {
  occurrences: Date[];
  capped: boolean;
}

// ---------------------------------------------------------------------------
// Small internal helpers
// ---------------------------------------------------------------------------

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/**
 * Absolute ceiling on interval-stepping iterations. The `k0` seek lands the
 * cursor next to the target, so real runs take only a handful of steps; this is
 * pure defense against an infinite loop from a future logic error.
 */
const SAFETY_ITERATIONS = 100_000;

/** A civil (wall-clock) calendar date. `month` is 1-based (1–12). */
interface CivilDate {
  year: number;
  month: number;
  day: number;
}

/** Normalized interval schedule, ready for stepping. */
interface NormalizedInterval {
  base: CivilDate; // civil date of the anchor, in `tz`
  hour: number; // local clock hour for every occurrence
  minute: number; // local clock minute for every occurrence
  unit: "day" | "week" | "month";
  count: number; // >= 1
  tz: string;
}

function toDate(value: Date | string | null): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseTimeOfDay(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** Last day (28–31) of a civil month. `month` is 1-based. */
function daysInCivilMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of `month`.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Add `days` to a civil date. Uses UTC arithmetic (no DST), so this is exact
 * calendar-date math independent of any timezone.
 */
function addCivilDays(date: CivilDate, days: number): CivilDate {
  const dt = new Date(Date.UTC(date.year, date.month - 1, date.day) + days * MS_PER_DAY);
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}

/**
 * Add `months` calendar months to a civil date, clamping the day to the target
 * month's length (e.g. Jan 31 + 1 month -> Feb 28/29).
 */
function addCivilMonths(date: CivilDate, months: number): CivilDate {
  const total = date.year * 12 + (date.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const day = Math.min(date.day, daysInCivilMonth(year, month));
  return { year, month, day };
}

/** Whole civil days from `a` to `b` (positive when `b` is later). */
function civilDaysBetween(a: CivilDate, b: CivilDate): number {
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / MS_PER_DAY,
  );
}

/** Whole civil months from `a` to `b` (day-of-month ignored). */
function civilMonthsBetween(a: CivilDate, b: CivilDate): number {
  return (b.year - a.year) * 12 + (b.month - a.month);
}

function normalizeInterval(input: CalendarScheduleInput): NormalizedInterval | null {
  const anchor = toDate(input.anchorAt);
  if (!anchor) return null;
  const unit = input.intervalUnit;
  if (unit == null) return null;
  const count = input.intervalCount != null && input.intervalCount > 0 ? input.intervalCount : 1;

  const anchorCivil = getZonedMinuteParts(anchor, input.timezone);
  let hour = anchorCivil.hour;
  let minute = anchorCivil.minute;
  if (input.timeOfDay) {
    const parsed = parseTimeOfDay(input.timeOfDay);
    if (parsed) {
      hour = parsed.hour;
      minute = parsed.minute;
    }
  }

  return {
    base: { year: anchorCivil.year, month: anchorCivil.month, day: anchorCivil.day },
    hour,
    minute,
    unit,
    count,
    tz: input.timezone,
  };
}

/** The civil date of the k-th occurrence (k >= 0), by cadence. */
function occurrenceCivil(norm: NormalizedInterval, k: number): CivilDate {
  if (norm.unit === "month") {
    return addCivilMonths(norm.base, k * norm.count);
  }
  const stepDays = norm.unit === "week" ? norm.count * 7 : norm.count;
  return addCivilDays(norm.base, k * stepDays);
}

/** The UTC instant of the k-th interval occurrence at the fixed local clock. */
function occurrenceAt(norm: NormalizedInterval, k: number): Date {
  const civil = occurrenceCivil(norm, k);
  return civilToUtc(civil.year, civil.month, civil.day, norm.hour, norm.minute, norm.tz);
}

/**
 * A starting occurrence index at or below the one nearest `seekRef`, so the
 * caller can step upward without iterating from the (possibly ancient) anchor.
 * The `-2` back-off guards off-by-one around DST shifts and month-day clamping.
 */
function seekStartIndex(norm: NormalizedInterval, seekRef: Date): number {
  const refParts = getZonedMinuteParts(seekRef, norm.tz);
  const refDate: CivilDate = { year: refParts.year, month: refParts.month, day: refParts.day };
  if (norm.unit === "month") {
    const months = civilMonthsBetween(norm.base, refDate);
    return Math.max(0, Math.floor(months / norm.count) - 2);
  }
  const stepDays = norm.unit === "week" ? norm.count * 7 : norm.count;
  const days = civilDaysBetween(norm.base, refDate);
  return Math.max(0, Math.floor(days / stepDays) - 2);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The next NOTIFY instant strictly greater than `after`, where
 * NOTIFY = occurrence instant minus `leadTimeMinutes`. Returns `null` when the
 * schedule has no further reminder (past one-off, exhausted `maxOccurrences`,
 * or beyond `endAt`).
 */
export function computeNextRun(input: CalendarScheduleInput, after: Date): Date | null {
  const leadMs = Math.max(0, input.leadTimeMinutes) * MS_PER_MINUTE;
  const afterMs = after.getTime();
  const endAt = toDate(input.endAt);

  if (input.scheduleKind === "once") {
    const anchor = toDate(input.anchorAt);
    if (!anchor) return null;
    const notifyMs = anchor.getTime() - leadMs;
    return notifyMs > afterMs ? new Date(notifyMs) : null;
  }

  if (input.scheduleKind === "cron") {
    if (!input.cronExpression) return null;
    // Occurrences march forward from `after`; the NOTIFY instant is the
    // occurrence minus lead, so keep advancing until a notify lands past `after`
    // (a large lead can push the first few notifies back before `after`).
    let occ = nextCronTickInTimeZone(input.cronExpression, input.timezone, after);
    for (let i = 0; occ && i < SAFETY_ITERATIONS; i += 1) {
      if (endAt && occ.getTime() > endAt.getTime()) return null;
      const notifyMs = occ.getTime() - leadMs;
      if (notifyMs > afterMs) return new Date(notifyMs);
      occ = nextCronTickInTimeZone(input.cronExpression, input.timezone, occ);
    }
    return null;
  }

  // interval
  const norm = normalizeInterval(input);
  if (!norm) return null;
  const seekRef = new Date(afterMs + leadMs);
  const k0 = seekStartIndex(norm, seekRef);
  for (let k = k0; k < k0 + SAFETY_ITERATIONS; k += 1) {
    if (input.maxOccurrences != null && k >= input.maxOccurrences) return null;
    const occ = occurrenceAt(norm, k);
    if (endAt && occ.getTime() > endAt.getTime()) return null;
    const notifyMs = occ.getTime() - leadMs;
    if (notifyMs > afterMs) return new Date(notifyMs);
  }
  return null;
}

/**
 * All OCCURRENCE instants (not notify instants) within `[rangeStart, rangeEnd]`
 * inclusive, ascending, for calendar rendering. Returns at most `cap`
 * occurrences; `capped` is `true` when more occurrences exist in the window than
 * `cap` allowed (the caller may log this).
 */
export function expandOccurrences(
  input: CalendarScheduleInput,
  rangeStart: Date,
  rangeEnd: Date,
  cap = 366,
): ExpandResult {
  const occurrences: Date[] = [];
  const startMs = rangeStart.getTime();
  const endMs = rangeEnd.getTime();
  const endAt = toDate(input.endAt);

  if (input.scheduleKind === "once") {
    const anchor = toDate(input.anchorAt);
    if (anchor && anchor.getTime() >= startMs && anchor.getTime() <= endMs) {
      occurrences.push(anchor);
    }
    return { occurrences, capped: false };
  }

  if (input.scheduleKind === "cron") {
    if (!input.cronExpression) return { occurrences, capped: false };
    // Subtract 1ms so an occurrence landing exactly on `rangeStart` is included
    // (nextCronTickInTimeZone returns instants strictly after its argument).
    let occ = nextCronTickInTimeZone(input.cronExpression, input.timezone, new Date(startMs - 1));
    let capped = false;
    while (occ && occ.getTime() <= endMs) {
      if (endAt && occ.getTime() > endAt.getTime()) break;
      if (occurrences.length >= cap) {
        capped = true;
        break;
      }
      occurrences.push(occ);
      occ = nextCronTickInTimeZone(input.cronExpression, input.timezone, occ);
    }
    return { occurrences, capped };
  }

  // interval
  const norm = normalizeInterval(input);
  if (!norm) return { occurrences, capped: false };
  const k0 = seekStartIndex(norm, rangeStart);
  const guardLimit = k0 + cap + 4096;
  let capped = false;
  for (let k = k0; k < guardLimit; k += 1) {
    if (input.maxOccurrences != null && k >= input.maxOccurrences) break;
    const occ = occurrenceAt(norm, k);
    const occMs = occ.getTime();
    if (endAt && occMs > endAt.getTime()) break;
    if (occMs > endMs) break;
    if (occMs >= startMs) {
      if (occurrences.length >= cap) {
        capped = true;
        break;
      }
      occurrences.push(occ);
    }
  }
  return { occurrences, capped };
}
