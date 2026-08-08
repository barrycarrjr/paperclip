import { describe, expect, it } from "vitest";
import {
  buildServerLogQueryString,
  formatLogTime,
  levelBadgeClass,
  levelToneClass,
  logDayKey,
} from "./server-log-view";

describe("buildServerLogQueryString", () => {
  it("leaves out everything unset", () => {
    expect(buildServerLogQueryString({})).toBe("");
  });

  it("includes the values that are set", () => {
    expect(buildServerLogQueryString({ limit: 50, minLevel: "warn" })).toBe("?limit=50&level=warn");
  });

  it("drops a search box that has been cleared", () => {
    // Sending search= would filter on an empty string rather than not filter.
    expect(buildServerLogQueryString({ search: "" })).toBe("");
    expect(buildServerLogQueryString({ search: "   " })).toBe("");
  });

  it("trims and escapes the search term", () => {
    expect(buildServerLogQueryString({ search: "  GET /api  " })).toBe("?search=GET+%2Fapi");
  });

  it("keeps afterTimeMs of zero rather than treating it as unset", () => {
    expect(buildServerLogQueryString({ afterTimeMs: 0 })).toBe("?afterTimeMs=0");
  });
});

describe("formatLogTime", () => {
  it("renders a 24-hour clock time", () => {
    expect(formatLogTime(Date.UTC(2026, 7, 7, 12, 34, 56))).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("does not pretend a missing timestamp is midnight", () => {
    expect(formatLogTime(0)).toBe("--:--:--");
    expect(formatLogTime(Number.NaN)).toBe("--:--:--");
  });
});

describe("logDayKey", () => {
  it("groups entries from the same day together", () => {
    const morning = Date.UTC(2026, 7, 7, 9, 0, 0);
    const evening = Date.UTC(2026, 7, 7, 21, 0, 0);
    expect(logDayKey(morning)).toBe(logDayKey(evening));
  });
});

describe("level styling", () => {
  it("gives every level a tone and a badge", () => {
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
      expect(levelToneClass(level)).toBeTruthy();
      expect(levelBadgeClass(level)).toBeTruthy();
    }
  });

  it("makes problems visually distinct from routine lines", () => {
    expect(levelToneClass("error")).not.toBe(levelToneClass("info"));
    expect(levelToneClass("warn")).not.toBe(levelToneClass("info"));
  });
});
