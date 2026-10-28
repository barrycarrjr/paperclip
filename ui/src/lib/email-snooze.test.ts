import { describe, expect, it } from "vitest";
import { snoozeOptions } from "./email-snooze";

// Local-time constructors keep these tests independent of the machine's timezone.
describe("snoozeOptions", () => {
  it("offers four choices, all in the future and in order of distance", () => {
    const now = new Date(2026, 9, 28, 15, 35); // Wed 28 Oct 2026, 3:35 pm
    const opts = snoozeOptions(now);
    expect(opts.map((o) => o.key)).toEqual(["three-hours", "tomorrow", "weekend", "next-week"]);
    for (const o of opts) expect(o.until.getTime()).toBeGreaterThan(now.getTime());
    expect(opts[0]!.until).toEqual(new Date(2026, 9, 28, 18, 35));
    expect(opts[1]!.until).toEqual(new Date(2026, 9, 29, 8, 0));
    expect(opts[2]!.until).toEqual(new Date(2026, 9, 31, 8, 0)); // Sat 31 Oct
    expect(opts[3]!.until).toEqual(new Date(2026, 10, 2, 8, 0)); // Mon 2 Nov
  });

  it("on a Saturday the weekend choice is next Saturday, not now", () => {
    const now = new Date(2026, 9, 31, 9, 0); // Sat 31 Oct
    const weekend = snoozeOptions(now).find((o) => o.key === "weekend")!;
    expect(weekend.until).toEqual(new Date(2026, 10, 7, 8, 0));
  });

  it("on a Monday next week is seven days on", () => {
    const now = new Date(2026, 10, 2, 7, 0); // Mon 2 Nov
    const next = snoozeOptions(now).find((o) => o.key === "next-week")!;
    expect(next.until).toEqual(new Date(2026, 10, 9, 8, 0));
  });
});
