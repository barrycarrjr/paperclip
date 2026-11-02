import { describe, expect, it } from "vitest";
import {
  combineSnoozeDateTime,
  defaultCustomSnooze,
  formatSnoozeChoiceTime,
  isPastDay,
  monthGrid,
  snoozeOptions,
  toDateInputValue,
  toTimeInputValue,
} from "./email-snooze";

const keys = (now: Date) => snoozeOptions(now).map((o) => o.key);
const until = (now: Date, key: string) => snoozeOptions(now).find((o) => o.key === key)?.until;

// Local-time constructors keep these tests independent of the machine's timezone.
describe("snoozeOptions", () => {
  it("on a Wednesday afternoon offers all five Gmail choices at the right times", () => {
    const now = new Date(2026, 9, 28, 15, 35); // Wed 28 Oct 2026, 3:35 pm
    expect(keys(now)).toEqual(["later-today", "tomorrow", "later-this-week", "weekend", "next-week"]);
    expect(until(now, "later-today")).toEqual(new Date(2026, 9, 28, 18, 0));
    expect(until(now, "tomorrow")).toEqual(new Date(2026, 9, 29, 8, 0));
    expect(until(now, "later-this-week")).toEqual(new Date(2026, 9, 30, 8, 0)); // Fri
    expect(until(now, "weekend")).toEqual(new Date(2026, 9, 31, 8, 0)); // Sat
    expect(until(now, "next-week")).toEqual(new Date(2026, 10, 2, 8, 0)); // Mon
  });

  it("hides Later today once it is 6 PM or later", () => {
    expect(keys(new Date(2026, 9, 28, 18, 0))).not.toContain("later-today");
    expect(keys(new Date(2026, 9, 28, 21, 15))).not.toContain("later-today");
    expect(keys(new Date(2026, 9, 28, 17, 59))).toContain("later-today");
  });

  it("hides Later this week when two days out is a weekend day", () => {
    expect(keys(new Date(2026, 9, 29, 9, 0))).not.toContain("later-this-week"); // Thu -> Sat
    expect(keys(new Date(2026, 9, 30, 9, 0))).not.toContain("later-this-week"); // Fri -> Sun
    expect(keys(new Date(2026, 9, 26, 9, 0))).toContain("later-this-week"); // Mon -> Wed
  });

  it("drops a choice that lands on the same moment as an earlier one", () => {
    const friday = new Date(2026, 9, 30, 9, 0); // Tomorrow is Sat 8 AM = This weekend
    expect(keys(friday)).toEqual(["later-today", "tomorrow", "next-week"]);
    const sunday = new Date(2026, 10, 1, 9, 0); // Tomorrow is Mon 8 AM = Next week
    expect(keys(sunday)).not.toContain("next-week");
    expect(keys(sunday)).toContain("tomorrow");
  });

  it("never offers a time that is not after now", () => {
    for (let h = 0; h < 24; h++) {
      for (let day = 25; day <= 31; day++) {
        const now = new Date(2026, 9, day, h, 30);
        for (const o of snoozeOptions(now)) expect(o.until.getTime()).toBeGreaterThan(now.getTime());
      }
    }
  });

  it("on a Saturday the weekend choice is next Saturday, not now", () => {
    const now = new Date(2026, 9, 31, 9, 0); // Sat 31 Oct
    expect(until(now, "weekend")).toEqual(new Date(2026, 10, 7, 8, 0));
  });

  it("on a Monday next week is seven days on", () => {
    const now = new Date(2026, 10, 2, 7, 0); // Mon 2 Nov
    expect(until(now, "next-week")).toEqual(new Date(2026, 10, 9, 8, 0));
  });
});

describe("formatSnoozeChoiceTime", () => {
  const now = new Date(2026, 9, 28, 15, 35); // Wed
  it("shows just the time for today", () => {
    expect(formatSnoozeChoiceTime(new Date(2026, 9, 28, 18, 0), now)).toMatch(/^6:00\s?PM$/i);
  });
  it("shows the weekday and time within the coming week", () => {
    expect(formatSnoozeChoiceTime(new Date(2026, 9, 29, 8, 0), now)).toMatch(/^Thu, 8:00\s?AM$/i);
  });
  it("adds the date when a week or more away", () => {
    expect(formatSnoozeChoiceTime(new Date(2026, 10, 4, 8, 0), now)).toMatch(/Nov 4/);
  });
});

describe("pick date and time helpers", () => {
  it("defaults to tomorrow at 8:00 AM", () => {
    expect(defaultCustomSnooze(new Date(2026, 9, 31, 22, 10))).toEqual(new Date(2026, 10, 1, 8, 0));
  });

  it("round-trips the date and time input values", () => {
    const d = new Date(2026, 0, 5, 7, 5);
    expect(toDateInputValue(d)).toBe("2026-01-05");
    expect(toTimeInputValue(d)).toBe("07:05");
  });

  it("combines fields into a local moment, rejecting past, empty and impossible values", () => {
    const now = new Date(2026, 9, 28, 15, 0);
    expect(combineSnoozeDateTime("2026-10-29", "08:00", now)).toEqual(new Date(2026, 9, 29, 8, 0));
    expect(combineSnoozeDateTime("2026-10-28", "14:00", now)).toBeNull();
    expect(combineSnoozeDateTime("2026-10-28", "15:00", now)).toBeNull();
    expect(combineSnoozeDateTime("", "08:00", now)).toBeNull();
    expect(combineSnoozeDateTime("2026-10-29", "", now)).toBeNull();
    expect(combineSnoozeDateTime("2026-02-31", "08:00", new Date(2026, 0, 1))).toBeNull();
    expect(combineSnoozeDateTime("2026-10-29", "25:00", now)).toBeNull();
  });

  it("lays a month out in Sunday-first weeks padded with nulls", () => {
    const weeks = monthGrid(2026, 10); // Nov 2026 starts on a Sunday, 30 days
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(weeks[0]![0]).toEqual(new Date(2026, 10, 1));
    expect(weeks.flat().filter(Boolean)).toHaveLength(30);
    const oct = monthGrid(2026, 9); // Oct 2026 starts on a Thursday
    expect(oct[0]!.slice(0, 4)).toEqual([null, null, null, null]);
    expect(oct[0]![4]).toEqual(new Date(2026, 9, 1));
  });

  it("treats earlier days as past but today as pickable", () => {
    const now = new Date(2026, 9, 28, 15, 0);
    expect(isPastDay(new Date(2026, 9, 27), now)).toBe(true);
    expect(isPastDay(new Date(2026, 9, 28), now)).toBe(false);
    expect(isPastDay(new Date(2026, 9, 29), now)).toBe(false);
  });
});
