// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  MORNING_HOUR,
  SNOOZE_PRESETS,
  SNOOZE_PRESET_LABELS,
  describeSnoozeUntil,
  resolveSnoozePreset,
} from "./snooze-presets";

/** Local time, because "tomorrow morning" is a wall-clock idea. */
function at(iso: string): Date {
  return new Date(iso);
}

describe("resolveSnoozePreset", () => {
  it("adds the hours for the short ones", () => {
    const from = at("2026-08-06T14:30:00");
    expect(resolveSnoozePreset("1h", from).getTime() - from.getTime()).toBe(60 * 60_000);
    expect(resolveSnoozePreset("3h", from).getTime() - from.getTime()).toBe(3 * 60 * 60_000);
  });

  it("means tomorrow morning, not this time tomorrow", () => {
    const result = resolveSnoozePreset("tomorrow", at("2026-08-06T22:15:00"));
    expect(result.getDate()).toBe(7);
    expect(result.getHours()).toBe(MORNING_HOUR);
    expect(result.getMinutes()).toBe(0);
  });

  it("rolls tomorrow into the next month correctly", () => {
    const result = resolveSnoozePreset("tomorrow", at("2026-08-31T18:00:00"));
    expect(result.getMonth()).toBe(8); // September
    expect(result.getDate()).toBe(1);
  });

  it("means the next Monday morning", () => {
    // 2026-08-06 is a Thursday.
    const result = resolveSnoozePreset("next-week", at("2026-08-06T10:00:00"));
    expect(result.getDay()).toBe(1);
    expect(result.getDate()).toBe(10);
    expect(result.getHours()).toBe(MORNING_HOUR);
  });

  it("from a Monday, means the Monday after, never today", () => {
    // Otherwise "until Monday" could resolve to a time that has already gone,
    // and the row would come straight back.
    const monday = at("2026-08-10T11:00:00");
    expect(monday.getDay()).toBe(1);
    const result = resolveSnoozePreset("next-week", monday);
    expect(result.getDay()).toBe(1);
    expect(result.getDate()).toBe(17);
    expect(result.getTime()).toBeGreaterThan(monday.getTime());
  });

  it("from a Sunday, means the very next day", () => {
    const sunday = at("2026-08-09T11:00:00");
    expect(sunday.getDay()).toBe(0);
    const result = resolveSnoozePreset("next-week", sunday);
    expect(result.getDate()).toBe(10);
  });

  it("always resolves to the future, whatever the starting point", () => {
    for (const iso of [
      "2026-08-06T00:00:00",
      "2026-08-06T08:59:00",
      "2026-08-06T09:00:00",
      "2026-08-06T23:59:00",
    ]) {
      const from = at(iso);
      for (const preset of SNOOZE_PRESETS) {
        expect(resolveSnoozePreset(preset, from).getTime()).toBeGreaterThan(from.getTime());
      }
    }
  });

  it("has a label for every preset", () => {
    for (const preset of SNOOZE_PRESETS) {
      expect(SNOOZE_PRESET_LABELS[preset]).toBeTruthy();
    }
  });
});

describe("describeSnoozeUntil", () => {
  const NOW = at("2026-08-06T10:00:00").getTime();

  it("reads in the largest sensible unit", () => {
    expect(describeSnoozeUntil(NOW + 20 * 60_000, NOW)).toBe("back in 20m");
    expect(describeSnoozeUntil(NOW + 3 * 60 * 60_000, NOW)).toBe("back in 3h");
    expect(describeSnoozeUntil(NOW + 50 * 60 * 60_000, NOW)).toBe("back in 2d");
  });

  it("says it is back once the time has passed", () => {
    expect(describeSnoozeUntil(NOW - 60_000, NOW)).toBe("back now");
    expect(describeSnoozeUntil(NOW, NOW)).toBe("back now");
  });
});
