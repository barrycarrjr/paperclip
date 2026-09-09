import { describe, expect, it } from "vitest";
import { isRoutineOccurrence, KNOWN_SOURCES, resolveNotificationTime, sourceMeta } from "./calendar-utils";

describe("calendar sources", () => {
  it("offers routines in the legend so they can be switched off", () => {
    expect([...KNOWN_SOURCES]).toContain("routine");
    expect([...KNOWN_SOURCES]).toContain("paperclip");
  });

  it("gives routines their own label and colour, distinct from reminders", () => {
    const routine = sourceMeta("routine");
    const paperclip = sourceMeta("paperclip");

    expect(routine.label).toBe("Routines");
    expect(routine.dot).not.toBe(paperclip.dot);
    expect(routine.pill).not.toBe(paperclip.pill);
  });

  // The reminder dialog can neither edit nor delete a routine, so the pages
  // key off this to send the click to the routine instead.
  it("recognises a routine entry and nothing else", () => {
    expect(isRoutineOccurrence("routine")).toBe(true);
    expect(isRoutineOccurrence("paperclip")).toBe(false);
    expect(isRoutineOccurrence("google")).toBe(false);
    expect(isRoutineOccurrence("")).toBe(false);
  });

  it("still falls back for a source it has never seen", () => {
    expect(sourceMeta("apple").label).toBe("apple");
  });
});

// P3 audit, 2026-09-03: A10/F13 require notification time distinguished from
// occurrence time; nothing in the UI surfaced this before resolveNotificationTime.
describe("resolveNotificationTime", () => {
  it("moves the notification earlier by the lead time", () => {
    const result = resolveNotificationTime({
      notify: true,
      nextRunAt: "2026-09-10T14:00:00.000Z",
      leadTimeMinutes: 30,
    });
    expect(result?.notifyAt.toISOString()).toBe("2026-09-10T13:30:00.000Z");
    expect(result?.leadsEvent).toBe(true);
  });

  it("matches the occurrence time exactly when there is no lead time", () => {
    const result = resolveNotificationTime({
      notify: true,
      nextRunAt: "2026-09-10T14:00:00.000Z",
      leadTimeMinutes: 0,
    });
    expect(result?.notifyAt.toISOString()).toBe("2026-09-10T14:00:00.000Z");
    expect(result?.leadsEvent).toBe(false);
  });

  it("returns null when notifications are off", () => {
    expect(
      resolveNotificationTime({ notify: false, nextRunAt: "2026-09-10T14:00:00.000Z", leadTimeMinutes: 30 }),
    ).toBeNull();
  });

  it("returns null when there is no next occurrence yet", () => {
    expect(resolveNotificationTime({ notify: true, nextRunAt: null, leadTimeMinutes: 30 })).toBeNull();
  });
});
