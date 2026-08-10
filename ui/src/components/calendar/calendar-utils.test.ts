import { describe, expect, it } from "vitest";
import { isRoutineOccurrence, KNOWN_SOURCES, sourceMeta } from "./calendar-utils";

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
