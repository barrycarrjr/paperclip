import { describe, expect, it } from "vitest";
import { formatNextWake, nextWakeAtMs } from "./next-wake";

const NOW = 1_754_000_000_000;

function agent(
  overrides: Partial<Parameters<typeof nextWakeAtMs>[0]> = {},
): Parameters<typeof nextWakeAtMs>[0] {
  return {
    schedulerActive: true,
    heartbeatIntervalSec: 3600,
    lastHeartbeatAt: new Date(NOW - 30 * 60_000).toISOString(),
    createdAt: new Date(NOW - 86_400_000).toISOString(),
    ...overrides,
  };
}

describe("nextWakeAtMs", () => {
  it("is last heartbeat plus the interval", () => {
    expect(nextWakeAtMs(agent())).toBe(NOW - 30 * 60_000 + 3600 * 1000);
  });
  it("falls back to creation time when the agent never ran", () => {
    expect(nextWakeAtMs(agent({ lastHeartbeatAt: null }))).toBe(
      NOW - 86_400_000 + 3600 * 1000,
    );
  });
  it("returns null when the scheduler is off or fields are missing", () => {
    expect(nextWakeAtMs(agent({ schedulerActive: false }))).toBeNull();
    expect(nextWakeAtMs(agent({ schedulerActive: undefined }))).toBeNull();
    expect(nextWakeAtMs(agent({ heartbeatIntervalSec: 0 }))).toBeNull();
    expect(nextWakeAtMs(agent({ heartbeatIntervalSec: undefined }))).toBeNull();
  });
});

describe("formatNextWake", () => {
  it("counts down in minutes and hours", () => {
    expect(formatNextWake(NOW + 22 * 60_000, NOW)).toBe("wakes in 22m");
    expect(formatNextWake(NOW + 185 * 60_000, NOW)).toBe("wakes in 3h 05m");
    expect(formatNextWake(NOW + 26 * 3600_000, NOW)).toBe("wakes in 1d 2h");
  });
  it("says waking soon just past due, then reports a real overdue honestly", () => {
    expect(formatNextWake(NOW - 5_000, NOW)).toBe("waking soon");
    expect(formatNextWake(NOW - 10 * 60_000, NOW)).toBe("wake overdue by 10m");
    expect(formatNextWake(NOW - 3 * 3600_000, NOW)).toBe("wake overdue by 3h");
  });
});
