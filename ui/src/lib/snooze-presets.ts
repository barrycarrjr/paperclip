/**
 * How long "not now" means.
 *
 * Kept as a pure preset-to-timestamp function rather than inline arithmetic at
 * a button, because the interesting cases are the ones with a rule behind them
 * ("tomorrow morning" means 9am tomorrow, not 24 hours from now) and those are
 * worth testing. Mirrors the shape of lib/useDateRange: a labelled union, a
 * pure resolver, and a Custom option that reveals a native input.
 */

export const SNOOZE_PRESETS = ["1h", "3h", "tomorrow", "next-week"] as const;
export type SnoozePreset = (typeof SNOOZE_PRESETS)[number];

export const SNOOZE_PRESET_LABELS: Record<SnoozePreset, string> = {
  "1h": "For an hour",
  "3h": "For three hours",
  tomorrow: "Until tomorrow morning",
  "next-week": "Until Monday morning",
};

/** The hour "morning" means. Early enough to be the start of a working day. */
export const MORNING_HOUR = 9;

/**
 * Resolve a preset against a moment. `from` is passed in rather than read from
 * the clock so this stays pure and the calendar cases can be tested.
 */
export function resolveSnoozePreset(preset: SnoozePreset, from: Date): Date {
  switch (preset) {
    case "1h":
      return new Date(from.getTime() + 60 * 60_000);
    case "3h":
      return new Date(from.getTime() + 3 * 60 * 60_000);
    case "tomorrow": {
      const next = new Date(from);
      next.setDate(next.getDate() + 1);
      next.setHours(MORNING_HOUR, 0, 0, 0);
      return next;
    }
    case "next-week": {
      const next = new Date(from);
      // Monday. Snoozing on a Monday means the Monday after, never today,
      // otherwise "until Monday" could resolve to a time already past.
      const daysUntilMonday = ((8 - next.getDay()) % 7) || 7;
      next.setDate(next.getDate() + daysUntilMonday);
      next.setHours(MORNING_HOUR, 0, 0, 0);
      return next;
    }
  }
}

/** "back in 20m", "back at 9am tomorrow" - what the row says while it is away. */
export function describeSnoozeUntil(untilMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.round((untilMs - nowMs) / 60_000));
  if (minutes < 1) return "back now";
  if (minutes < 60) return `back in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `back in ${hours}h`;
  const days = Math.round(hours / 24);
  return `back in ${days}d`;
}
