/**
 * Snooze choices for the Email view.
 *
 * The times are worked out here, in the operator's own timezone, and sent to
 * the plugin as an exact moment: the server does not know where the operator
 * is, so it cannot work out "tomorrow morning" itself.
 */

export interface SnoozeOption {
  key: "three-hours" | "tomorrow" | "weekend" | "next-week";
  label: string;
  until: Date;
}

const MORNING_HOUR = 8;

function atMorning(day: Date): Date {
  const d = new Date(day);
  d.setHours(MORNING_HOUR, 0, 0, 0);
  return d;
}

/** The next given weekday (0 = Sunday) at 8:00, strictly after `now`'s own day. */
function nextWeekday(now: Date, weekday: number): Date {
  const d = new Date(now);
  const ahead = ((weekday - d.getDay() + 7) % 7) || 7;
  d.setDate(d.getDate() + ahead);
  return atMorning(d);
}

export function snoozeOptions(now: Date = new Date()): SnoozeOption[] {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return [
    { key: "three-hours", label: "In 3 hours", until: new Date(now.getTime() + 3 * 3_600_000) },
    { key: "tomorrow", label: "Tomorrow morning", until: atMorning(tomorrow) },
    { key: "weekend", label: "This weekend", until: nextWeekday(now, 6) },
    { key: "next-week", label: "Next week", until: nextWeekday(now, 1) },
  ];
}

/** "Back tomorrow at 8:00 AM" style text for a confirmation toast. */
export function describeSnoozeUntil(until: Date, now: Date = new Date()): string {
  const time = until.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sameDay = until.toDateString() === now.toDateString();
  if (sameDay) return `today at ${time}`;
  const day = until.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
  return `${day} at ${time}`;
}
