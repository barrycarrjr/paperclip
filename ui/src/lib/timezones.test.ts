import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeTimeZone,
  formatInstantInTimeZone,
  formatTimeZoneOffset,
  getBrowserTimeZone,
  listTimeZones,
} from "./timezones";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Pretend the browser is set to `zone`, the way a real one would report it. */
function pretendBrowserZone(zone: string | undefined) {
  const real = Intl.DateTimeFormat;
  vi.spyOn(Intl, "DateTimeFormat").mockImplementation(((...args: unknown[]) => {
    const formatter = new (real as unknown as new (...a: unknown[]) => Intl.DateTimeFormat)(...args);
    if (args.length === 0) {
      return {
        ...formatter,
        resolvedOptions: () => ({ ...formatter.resolvedOptions(), timeZone: zone }),
      } as Intl.DateTimeFormat;
    }
    return formatter;
  }) as unknown as typeof Intl.DateTimeFormat);
}

describe("getBrowserTimeZone", () => {
  it("reports the zone the browser is set to", () => {
    pretendBrowserZone("Asia/Tokyo");
    expect(getBrowserTimeZone()).toBe("Asia/Tokyo");
  });

  it("falls back to UTC when the browser will not say", () => {
    pretendBrowserZone(undefined);
    expect(getBrowserTimeZone()).toBe("UTC");
  });
});

describe("listTimeZones", () => {
  it("offers the browser's own zone first", () => {
    pretendBrowserZone("Europe/Lisbon");
    expect(listTimeZones()[0]).toBe("Europe/Lisbon");
  });

  it("keeps the already saved zone in the list, second only to the browser's", () => {
    pretendBrowserZone("Europe/Lisbon");
    const zones = listTimeZones("Pacific/Chatham");
    expect(zones[0]).toBe("Europe/Lisbon");
    expect(zones[1]).toBe("Pacific/Chatham");
  });

  it("lists every zone only once", () => {
    const zones = listTimeZones("UTC");
    expect(new Set(zones).size).toBe(zones.length);
  });

  it("includes the common zones a person is most likely to want", () => {
    const zones = listTimeZones();
    expect(zones).toContain("America/New_York");
    expect(zones).toContain("Europe/London");
    expect(zones).toContain("Asia/Tokyo");
  });
});

describe("formatTimeZoneOffset", () => {
  const midsummer = new Date("2026-07-01T12:00:00.000Z");
  const midwinter = new Date("2026-01-01T12:00:00.000Z");

  it("says how far a zone is from UTC", () => {
    expect(formatTimeZoneOffset("America/New_York", midsummer)).toBe("UTC-04:00");
    expect(formatTimeZoneOffset("Asia/Tokyo", midsummer)).toBe("UTC+09:00");
  });

  it("follows daylight saving rather than assuming a fixed offset", () => {
    expect(formatTimeZoneOffset("America/New_York", midwinter)).toBe("UTC-05:00");
  });

  it("writes UTC itself with an explicit zero offset", () => {
    expect(formatTimeZoneOffset("UTC", midsummer)).toBe("UTC+00:00");
  });

  it("says nothing rather than guessing for a zone it does not know", () => {
    expect(formatTimeZoneOffset("Not/AZone", midsummer)).toBe("");
  });
});

describe("describeTimeZone", () => {
  it("names the zone and how far it is from UTC", () => {
    expect(describeTimeZone("America/Chicago", new Date("2026-07-01T12:00:00.000Z")))
      .toBe("America/Chicago (UTC-05:00)");
  });

  it("falls back to the bare name when the offset is unknown", () => {
    expect(describeTimeZone("Not/AZone")).toBe("Not/AZone");
  });
});

describe("formatInstantInTimeZone", () => {
  it("writes the moment on the named zone's clock, not the machine's", () => {
    const instant = new Date("2026-09-08T14:00:00.000Z");
    expect(formatInstantInTimeZone(instant, "America/New_York")).toContain("10:00 AM");
    expect(formatInstantInTimeZone(instant, "Europe/London")).toContain("3:00 PM");
    expect(formatInstantInTimeZone(instant, "Asia/Tokyo")).toContain("11:00 PM");
  });

  it("accepts the ISO string the API sends", () => {
    expect(formatInstantInTimeZone("2026-09-08T14:00:00.000Z", "UTC")).toContain("2:00 PM");
  });
});
