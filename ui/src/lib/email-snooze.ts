/**
 * Snooze choices for the Email view.
 *
 * The times are worked out here, in the operator's own timezone, and sent to
 * the plugin as an exact moment: the server does not know where the operator
 * is, so it cannot work out "tomorrow morning" itself.
 *
 * The preset list mirrors Gmail's: Later today, Tomorrow, Later this week,
 * This weekend, Next week. A choice that would land in the past, or on the
 * same moment as an earlier choice, is left out.
 */

export interface SnoozeOption {
  key: "later-today" | "tomorrow" | "later-this-week" | "weekend" | "next-week";
  label: string;
  until: Date;
}

const MORNING_HOUR = 8;
const EVENING_HOUR = 18;

function atHour(day: Date, hour: number): Date {
  const d = new Date(day);
  d.setHours(hour, 0, 0, 0);
  return d;
}

function addDays(day: Date, days: number): Date {
  const d = new Date(day);
  d.setDate(d.getDate() + days);
  return d;
}

/** The next given weekday (0 = Sunday) at 8:00, strictly after `now`'s own day. */
function nextWeekday(now: Date, weekday: number): Date {
  const ahead = ((weekday - now.getDay() + 7) % 7) || 7;
  return atHour(addDays(now, ahead), MORNING_HOUR);
}

export function snoozeOptions(now: Date = new Date()): SnoozeOption[] {
  const laterThisWeek = atHour(addDays(now, 2), MORNING_HOUR);
  const candidates: Array<SnoozeOption | null> = [
    { key: "later-today", label: "Later today", until: atHour(now, EVENING_HOUR) },
    { key: "tomorrow", label: "Tomorrow", until: atHour(addDays(now, 1), MORNING_HOUR) },
    // Two days out only counts as "this week" while it is still a weekday.
    laterThisWeek.getDay() >= 1 && laterThisWeek.getDay() <= 5
      ? { key: "later-this-week", label: "Later this week", until: laterThisWeek }
      : null,
    { key: "weekend", label: "This weekend", until: nextWeekday(now, 6) },
    { key: "next-week", label: "Next week", until: nextWeekday(now, 1) },
  ];
  const seen = new Set<number>();
  const out: SnoozeOption[] = [];
  for (const c of candidates) {
    if (!c) continue;
    const t = c.until.getTime();
    if (t <= now.getTime() || seen.has(t)) continue;
    seen.add(t);
    out.push(c);
  }
  return out;
}

/**
 * The time shown beside a menu choice: "6:00 PM" for today, "Tue, 8:00 AM" for
 * the coming week, "Sat, Nov 7, 8:00 AM" when it is a week or more away.
 */
export function formatSnoozeChoiceTime(until: Date, now: Date = new Date()): string {
  const time = until.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (until.toDateString() === now.toDateString()) return time;
  const daysAway = Math.round(
    (atHour(until, 0).getTime() - atHour(now, 0).getTime()) / 86_400_000,
  );
  if (daysAway < 7) {
    return `${until.toLocaleDateString([], { weekday: "short" })}, ${time}`;
  }
  return `${until.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}, ${time}`;
}

/** "Back tomorrow at 8:00 AM" style text for a confirmation toast. */
export function describeSnoozeUntil(until: Date, now: Date = new Date()): string {
  const time = until.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sameDay = until.toDateString() === now.toDateString();
  if (sameDay) return `today at ${time}`;
  const day = until.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
  return `${day} at ${time}`;
}

// ---- "Pick date & time" dialog helpers ----------------------------------

/** Where the dialog starts: tomorrow at 8:00 AM. */
export function defaultCustomSnooze(now: Date = new Date()): Date {
  return atHour(addDays(now, 1), MORNING_HOUR);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Value for an `<input type="date">`: YYYY-MM-DD in local time. */
export function toDateInputValue(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Value for an `<input type="time">`: HH:MM in local time. */
export function toTimeInputValue(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Combine the date and time fields into one moment. Returns null if either is
 * empty or malformed, or if the result is not in the future.
 */
export function combineSnoozeDateTime(
  dateValue: string,
  timeValue: string,
  now: Date = new Date(),
): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);
  const t = /^(\d{2}):(\d{2})$/.exec(timeValue);
  if (!d || !t) return null;
  const [y, mo, da, h, mi] = [d[1], d[2], d[3], t[1], t[2]].map(Number) as [number, number, number, number, number];
  const result = new Date(y, mo - 1, da, h, mi, 0, 0);
  // Reject rollovers such as Feb 31 or 25:00.
  if (
    result.getFullYear() !== y || result.getMonth() !== mo - 1 || result.getDate() !== da ||
    result.getHours() !== h || result.getMinutes() !== mi
  ) return null;
  return result.getTime() > now.getTime() ? result : null;
}

/** Weeks (Sunday first) of a month; days outside the month are null. */
export function monthGrid(year: number, month: number): Array<Array<Date | null>> {
  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: Array<Date | null> = [];
  for (let i = 0; i < first.getDay(); i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) cells.push(new Date(year, month, day));
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: Array<Array<Date | null>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** True when the whole calendar day is before today (so it cannot be picked). */
export function isPastDay(day: Date, now: Date = new Date()): boolean {
  return atHour(day, 0).getTime() < atHour(now, 0).getTime();
}
