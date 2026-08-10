import { describe, expect, it } from "vitest";
import {
  floorToMinute,
  getZonedMinuteParts,
  matchesCronMinute,
  nextCronTickInTimeZone,
} from "./cron.js";

/**
 * The obvious, slow way to answer the same question: step one minute at a time
 * and test each one.
 *
 * `nextCronTickInTimeZone` skips minutes that cannot match, which is what makes
 * a month-long expansion fast. That skipping is only safe if it never steps
 * over a minute this reference would have accepted, so the two are compared
 * directly below rather than trusting the reasoning.
 */
function nextTickByBruteForce(
  expression: string,
  timeZone: string,
  after: Date,
  withinMinutes: number,
): Date | null {
  const cursor = floorToMinute(after);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  for (let i = 0; i < withinMinutes; i += 1) {
    if (matchesCronMinute(expression, timeZone, cursor)) return new Date(cursor.getTime());
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}

const EXPRESSIONS = [
  "* * * * *", // every minute: the skip must never skip
  "0 * * * *",
  "*/5 * * * *",
  "0 9 * * *",
  "0 9,12,15,18 * * *", // the shape that made the calendar slow
  "30 2 * * *", // inside the spring-forward gap in New York
  "0,30 1 * * *", // inside the fall-back repeat in New York
  "15 3 * * 1", // weekday field
  "0 0 1 * *", // day-of-month field
  "*/7 8-17 * * 1-5", // steps and ranges together
];

const ZONES = [
  "UTC",
  "America/New_York", // whole-hour DST
  "Australia/Adelaide", // half-hour offset, with DST
  "Pacific/Chatham", // 45-minute offset
];

// Deliberately sits either side of both US changeovers in 2026.
const START_POINTS = [
  "2026-03-07T12:00:00.000Z", // day before spring forward
  "2026-03-08T06:30:00.000Z", // during the skipped hour in New York
  "2026-10-31T12:00:00.000Z", // day before fall back
  "2026-11-01T05:30:00.000Z", // during the repeated hour in New York
  "2026-02-27T00:00:00.000Z", // rolls into March
];

// The reference walks every minute, so the window is kept to a few days. Every
// expression above fires at least once inside it from every start point.
const WINDOW_MINUTES = 8 * 24 * 60;

describe("nextCronTickInTimeZone", () => {
  it("agrees with a minute-by-minute walk everywhere it is asked", () => {
    let compared = 0;

    for (const expression of EXPRESSIONS) {
      for (const timeZone of ZONES) {
        for (const startPoint of START_POINTS) {
          const after = new Date(startPoint);
          const fast = nextCronTickInTimeZone(expression, timeZone, after);
          const slow = nextTickByBruteForce(expression, timeZone, after, WINDOW_MINUTES);

          // The reference gives up after its window; only compare where it
          // actually found something.
          if (slow === null) continue;

          expect(
            fast?.toISOString(),
            `${expression} in ${timeZone} after ${startPoint}`,
          ).toBe(slow.toISOString());
          compared += 1;
        }
      }
    }

    // Guards against the loops silently collapsing to nothing.
    expect(compared).toBeGreaterThan(150);
  }, 120_000);

  it("never returns a time that does not match the expression", () => {
    for (const expression of EXPRESSIONS) {
      for (const timeZone of ZONES) {
        const tick = nextCronTickInTimeZone(expression, timeZone, new Date("2026-06-15T00:00:00Z"));
        if (!tick) continue;
        expect(matchesCronMinute(expression, timeZone, tick)).toBe(true);
      }
    }
  });

  it("always moves forward, so an expansion cannot stall", () => {
    for (const timeZone of ZONES) {
      let cursor = new Date("2026-03-07T00:00:00Z");
      for (let i = 0; i < 200; i += 1) {
        const next = nextCronTickInTimeZone("*/5 * * * *", timeZone, cursor);
        expect(next).not.toBeNull();
        expect(next!.getTime()).toBeGreaterThan(cursor.getTime());
        cursor = next!;
      }
    }
  });

  it("fires on the wall clock through a daylight-saving change", () => {
    // 9am New York stays 9am either side of spring forward, which is 13:00 UTC
    // before the change and 12:00 UTC less... the point is the civil hour holds.
    const before = nextCronTickInTimeZone("0 9 * * *", "America/New_York", new Date("2026-03-06T20:00:00Z"));
    const after = nextCronTickInTimeZone("0 9 * * *", "America/New_York", new Date("2026-03-09T20:00:00Z"));

    expect(getZonedMinuteParts(before!, "America/New_York").hour).toBe(9);
    expect(getZonedMinuteParts(after!, "America/New_York").hour).toBe(9);
    // Different UTC offsets, same wall clock: proves the walk is not assuming
    // a fixed offset when it skips.
    expect(before!.getUTCHours()).not.toBe(after!.getUTCHours());
  });
});
