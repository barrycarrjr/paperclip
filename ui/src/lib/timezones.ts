/**
 * Time zone helpers for anywhere a schedule is set or read.
 *
 * A schedule that only says "9:00 AM" does not say whose 9:00 AM. Paperclip
 * used to take the browser's own time zone and store it without ever showing
 * it, so the answer was invisible and unchangeable. These helpers keep the
 * browser's zone as the default, so nothing changes for someone who does not
 * care, while letting a page name the zone and offer another one.
 */

/** Used when the runtime cannot tell us anything at all about time zones. */
export const FALLBACK_TIME_ZONE = "UTC";

/**
 * Offered near the top of the picker, ahead of the full list. Kept in step
 * with the calendar event dialog, which offers the same short list.
 */
const COMMON_TIME_ZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
];

/**
 * The time zone this browser is set to, for example "America/New_York".
 *
 * This is the value Paperclip used to send silently when a schedule was
 * created. It is still the default, it is just visible now.
 */
export function getBrowserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || FALLBACK_TIME_ZONE;
  } catch {
    return FALLBACK_TIME_ZONE;
  }
}

/** Every zone this runtime knows about, or an empty list if it will not say. */
function supportedTimeZones(): string[] {
  try {
    const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    if (typeof supported !== "function") return [];
    return supported.call(Intl, "timeZone");
  } catch {
    return [];
  }
}

/**
 * The list of zones to offer, in the order to offer them: this browser's own
 * zone first, then whatever is already saved, then the common ones, then
 * everything else the runtime knows.
 *
 * `selected` is always included even when the runtime does not list it, so a
 * saved zone can never quietly drop out of its own picker and get replaced by
 * whatever happens to be first.
 */
export function listTimeZones(selected?: string | null): string[] {
  const ordered = [
    getBrowserTimeZone(),
    ...(selected ? [selected] : []),
    ...COMMON_TIME_ZONES,
    ...supportedTimeZones(),
  ];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const zone of ordered) {
    if (!zone || seen.has(zone)) continue;
    seen.add(zone);
    result.push(zone);
  }
  return result;
}

/**
 * Built once per zone. The picker asks for a label for every row it draws, and
 * building an `Intl.DateTimeFormat` is the expensive part.
 */
const OFFSET_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/**
 * How far ahead of or behind UTC `timeZone` is at `at`, written as
 * "UTC-04:00". Returns an empty string if the runtime cannot say.
 */
export function formatTimeZoneOffset(timeZone: string, at: Date = new Date()): string {
  try {
    let formatter = OFFSET_FORMATTERS.get(timeZone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" });
      OFFSET_FORMATTERS.set(timeZone, formatter);
    }
    const part = formatter.formatToParts(at).find((piece) => piece.type === "timeZoneName");
    if (!part) return "";
    const offset = part.value.replace(/^GMT/, "UTC");
    // Zones sitting exactly on UTC come back as a bare "UTC" with no digits.
    return offset === "UTC" ? "UTC+00:00" : offset;
  } catch {
    return "";
  }
}

/**
 * The label a person reads in a picker or a summary, for example
 * "America/New_York (UTC-04:00)".
 */
export function describeTimeZone(timeZone: string, at: Date = new Date()): string {
  const offset = formatTimeZoneOffset(timeZone, at);
  return offset ? `${timeZone} (${offset})` : timeZone;
}

/**
 * A moment in time written out on `timeZone`'s clock, for example
 * "Sep 8, 2026, 10:00 AM". Falls back to the browser's own clock if the zone
 * is one the runtime does not recognise.
 */
export function formatInstantInTimeZone(instant: Date | string, timeZone: string): string {
  const date = instant instanceof Date ? instant : new Date(instant);
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}
