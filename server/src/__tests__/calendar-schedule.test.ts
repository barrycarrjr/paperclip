import { describe, expect, it } from "vitest";
import {
  computeNextRun,
  expandOccurrences,
  type CalendarScheduleInput,
} from "../services/calendar-schedule.js";
import { getZonedMinuteParts } from "../services/cron.js";

const NY = "America/New_York";

function makeInput(partial: Partial<CalendarScheduleInput>): CalendarScheduleInput {
  return {
    scheduleKind: "interval",
    anchorAt: null,
    intervalUnit: null,
    intervalCount: null,
    timeOfDay: null,
    cronExpression: null,
    timezone: "UTC",
    endAt: null,
    maxOccurrences: null,
    leadTimeMinutes: 0,
    ...partial,
  };
}

function civilDaysBetween(a: Date, b: Date, tz: string): number {
  const pa = getZonedMinuteParts(a, tz);
  const pb = getZonedMinuteParts(b, tz);
  return Math.round(
    (Date.UTC(pb.year, pb.month - 1, pb.day) - Date.UTC(pa.year, pa.month - 1, pa.day)) / 86_400_000,
  );
}

describe("calendar-schedule: interval every 2 weeks (America/New_York)", () => {
  // 2026-03-02 is a Monday; 09:00 EST (UTC-5) === 14:00Z. US spring-forward is
  // 2026-03-08, so later occurrences fall under EDT (UTC-4).
  const input = makeInput({
    scheduleKind: "interval",
    intervalUnit: "week",
    intervalCount: 2,
    timezone: NY,
    anchorAt: new Date("2026-03-02T14:00:00Z"),
    timeOfDay: "09:00",
  });
  const occ0 = new Date("2026-03-02T14:00:00Z");

  it("computeNextRun just before occurrence[0] returns occurrence[0]", () => {
    const next = computeNextRun(input, new Date("2026-03-02T13:59:00Z"));
    expect(next?.toISOString()).toBe(occ0.toISOString());
  });

  it("occurrence[1] is +14 civil days, still 09:00 local, and the UTC hour shifts across DST", () => {
    const { occurrences } = expandOccurrences(
      input,
      new Date("2026-03-02T00:00:00Z"),
      new Date("2026-04-14T00:00:00Z"),
    );
    expect(occurrences).toHaveLength(4);

    // Every occurrence is an alternating Monday at 09:00 local, 14 days apart.
    for (const occ of occurrences) {
      const p = getZonedMinuteParts(occ, NY);
      expect(p.hour).toBe(9);
      expect(p.minute).toBe(0);
      expect(p.weekday).toBe(1); // Monday
    }
    for (let i = 1; i < occurrences.length; i += 1) {
      expect(civilDaysBetween(occurrences[i - 1]!, occurrences[i]!, NY)).toBe(14);
    }

    // occurrence[0] is EST (14:00Z); occurrence[1] is EDT (13:00Z) — same 09:00 local.
    expect(occurrences[0]!.toISOString()).toBe("2026-03-02T14:00:00.000Z");
    expect(occurrences[1]!.toISOString()).toBe("2026-03-16T13:00:00.000Z");
    expect(occurrences[0]!.getUTCHours()).toBe(14);
    expect(occurrences[1]!.getUTCHours()).toBe(13);
  });
});

describe("calendar-schedule: DST stability (weekly across spring-forward)", () => {
  // Anchor Sunday 2026-03-01 09:00 EST (14:00Z), weekly, spanning 2026-03-08 DST.
  const input = makeInput({
    scheduleKind: "interval",
    intervalUnit: "week",
    intervalCount: 1,
    timezone: NY,
    anchorAt: new Date("2026-03-01T14:00:00Z"),
    timeOfDay: "09:00",
  });

  it("every occurrence stays 09:00 LOCAL even though the UTC hour shifts", () => {
    const { occurrences } = expandOccurrences(
      input,
      new Date("2026-03-01T00:00:00Z"),
      new Date("2026-03-29T23:59:59Z"),
    );
    // Sundays: Mar 1, 8, 15, 22, 29.
    expect(occurrences).toHaveLength(5);
    for (const occ of occurrences) {
      const p = getZonedMinuteParts(occ, NY);
      expect(p.hour).toBe(9);
      expect(p.minute).toBe(0);
      expect(p.weekday).toBe(0); // Sunday
    }
    // Pre-DST occurrence is 14:00Z (EST); post-DST occurrences are 13:00Z (EDT).
    expect(occurrences[0]!.getUTCHours()).toBe(14);
    expect(occurrences[1]!.getUTCHours()).toBe(13);
    expect(occurrences[4]!.getUTCHours()).toBe(13);
  });
});

describe("calendar-schedule: monthly clamp", () => {
  it("Jan 31 monthly lands on Feb 28, Mar 31, Apr 30, May 31, Jun 30 (non-leap year)", () => {
    const input = makeInput({
      scheduleKind: "interval",
      intervalUnit: "month",
      intervalCount: 1,
      timezone: "UTC",
      anchorAt: new Date("2026-01-31T12:00:00Z"),
      // timeOfDay null -> falls back to the anchor's civil 12:00.
    });
    const { occurrences } = expandOccurrences(
      input,
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-06-30T23:59:59Z"),
    );
    const days = occurrences.map((o) => getZonedMinuteParts(o, "UTC").day);
    const months = occurrences.map((o) => getZonedMinuteParts(o, "UTC").month);
    expect(months).toEqual([1, 2, 3, 4, 5, 6]);
    expect(days).toEqual([31, 28, 31, 30, 31, 30]);
    // Clamping is measured from the anchor each step, so March returns to 31.
  });

  it("Jan 31 monthly clamps to Feb 29 in a leap year", () => {
    const input = makeInput({
      scheduleKind: "interval",
      intervalUnit: "month",
      intervalCount: 1,
      timezone: "UTC",
      anchorAt: new Date("2024-01-31T12:00:00Z"),
    });
    const { occurrences } = expandOccurrences(
      input,
      new Date("2024-01-01T00:00:00Z"),
      new Date("2024-02-29T23:59:59Z"),
    );
    expect(occurrences).toHaveLength(2);
    expect(getZonedMinuteParts(occurrences[1]!, "UTC").day).toBe(29);
  });
});

describe("calendar-schedule: once", () => {
  const after = new Date("2026-07-15T12:00:00Z");

  it("past anchor -> computeNextRun returns null", () => {
    const input = makeInput({ scheduleKind: "once", anchorAt: new Date("2026-01-01T00:00:00Z") });
    expect(computeNextRun(input, after)).toBeNull();
  });

  it("future anchor -> computeNextRun returns the anchor (minus lead)", () => {
    const input = makeInput({ scheduleKind: "once", anchorAt: new Date("2026-08-01T15:00:00Z") });
    expect(computeNextRun(input, after)?.toISOString()).toBe("2026-08-01T15:00:00.000Z");

    const withLead = makeInput({
      scheduleKind: "once",
      anchorAt: new Date("2026-08-01T15:00:00Z"),
      leadTimeMinutes: 30,
    });
    expect(computeNextRun(withLead, after)?.toISOString()).toBe("2026-08-01T14:30:00.000Z");
  });

  it("expandOccurrences includes the anchor only when it is in range", () => {
    const input = makeInput({ scheduleKind: "once", anchorAt: new Date("2026-08-01T15:00:00Z") });
    const inRange = expandOccurrences(
      input,
      new Date("2026-07-01T00:00:00Z"),
      new Date("2026-08-31T00:00:00Z"),
    );
    expect(inRange.occurrences.map((o) => o.toISOString())).toEqual(["2026-08-01T15:00:00.000Z"]);

    const outOfRange = expandOccurrences(
      input,
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-06-30T00:00:00Z"),
    );
    expect(outOfRange.occurrences).toHaveLength(0);
  });
});

describe("calendar-schedule: computeNextRun mid-sequence and termination", () => {
  const base = {
    scheduleKind: "interval" as const,
    intervalUnit: "week" as const,
    intervalCount: 2,
    timezone: NY,
    anchorAt: new Date("2026-03-02T14:00:00Z"),
    timeOfDay: "09:00",
  };
  // occurrence[0]=2026-03-02T14:00Z, [1]=2026-03-16T13:00Z, [2]=2026-03-30T13:00Z

  it("after between occurrence[1] and occurrence[2] returns occurrence[2]", () => {
    const input = makeInput(base);
    const next = computeNextRun(input, new Date("2026-03-20T00:00:00Z"));
    expect(next?.toISOString()).toBe("2026-03-30T13:00:00.000Z");
  });

  it("maxOccurrences=3 -> computeNextRun after occurrence[2] returns null", () => {
    const input = makeInput({ ...base, maxOccurrences: 3 });
    expect(computeNextRun(input, new Date("2026-03-31T00:00:00Z"))).toBeNull();
  });

  it("endAt between occ[1] and occ[2] -> returns null after occ[1]", () => {
    const input = makeInput({ ...base, endAt: new Date("2026-03-20T00:00:00Z") });
    expect(computeNextRun(input, new Date("2026-03-17T00:00:00Z"))).toBeNull();
  });

  it("lead time: computeNextRun returns the occurrence minus 15 minutes", () => {
    const input = makeInput({ ...base, leadTimeMinutes: 15 });
    const next = computeNextRun(input, new Date("2026-03-02T00:00:00Z"));
    // occurrence[0] civil is 09:00 local (14:00Z); notify is 15 min earlier.
    expect(next?.toISOString()).toBe("2026-03-02T13:45:00.000Z");
    expect(next!.getTime()).toBe(new Date("2026-03-02T14:00:00Z").getTime() - 15 * 60_000);
  });
});

describe("calendar-schedule: expand cap", () => {
  it("a daily event over a huge window with cap=10 returns 10 and capped=true", () => {
    const input = makeInput({
      scheduleKind: "interval",
      intervalUnit: "day",
      intervalCount: 1,
      timezone: "UTC",
      anchorAt: new Date("2026-01-01T09:00:00Z"),
    });
    const { occurrences, capped } = expandOccurrences(
      input,
      new Date("2026-01-01T00:00:00Z"),
      new Date("2027-01-01T00:00:00Z"),
      10,
    );
    expect(occurrences).toHaveLength(10);
    expect(capped).toBe(true);
    expect(occurrences[0]!.toISOString()).toBe("2026-01-01T09:00:00.000Z");
    expect(occurrences[9]!.toISOString()).toBe("2026-01-10T09:00:00.000Z");
  });
});

describe("calendar-schedule: cron", () => {
  it("expandOccurrences enumerates daily cron ticks and computeNextRun honors lead", () => {
    const input = makeInput({
      scheduleKind: "cron",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
    });
    const { occurrences } = expandOccurrences(
      input,
      new Date("2026-05-01T00:00:00Z"),
      new Date("2026-05-03T23:59:59Z"),
    );
    expect(occurrences.map((o) => o.toISOString())).toEqual([
      "2026-05-01T09:00:00.000Z",
      "2026-05-02T09:00:00.000Z",
      "2026-05-03T09:00:00.000Z",
    ]);

    const withLead = makeInput({
      scheduleKind: "cron",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      leadTimeMinutes: 15,
    });
    const next = computeNextRun(withLead, new Date("2026-05-01T00:00:00Z"));
    expect(next?.toISOString()).toBe("2026-05-01T08:45:00.000Z");
  });

  it("cron occurrence at exactly rangeStart is included", () => {
    const input = makeInput({
      scheduleKind: "cron",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
    });
    const { occurrences } = expandOccurrences(
      input,
      new Date("2026-05-01T09:00:00Z"),
      new Date("2026-05-01T09:00:00Z"),
    );
    expect(occurrences.map((o) => o.toISOString())).toEqual(["2026-05-01T09:00:00.000Z"]);
  });
});
