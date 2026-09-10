import { describe, expect, it } from "vitest";
import type { HeartbeatRun } from "@paperclipai/shared";
import { formatSuccessRate, summarizeAgentHealth } from "./agent-health";

const NOW = Date.parse("2026-09-09T15:00:00.000Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function run(
  overrides: Partial<HeartbeatRun> & { id: string; status: string },
): HeartbeatRun {
  return {
    companyId: "company-1",
    agentId: "a1",
    invocationSource: "timer",
    startedAt: new Date(NOW - MIN),
    finishedAt: new Date(NOW),
    createdAt: new Date(NOW - MIN),
    updatedAt: new Date(NOW),
    ...overrides,
  } as unknown as HeartbeatRun;
}

function summarize(runs: HeartbeatRun[]) {
  return summarizeAgentHealth(runs, { now: NOW });
}

describe("summarizeAgentHealth", () => {
  it("reports nothing at all rather than a made-up zero", () => {
    const health = summarize([]);

    expect(health.total).toBe(0);
    expect(health.successRate).toBeNull();
    expect(health.typicalDurationMs).toBeNull();
    expect(formatSuccessRate(health.successRate)).toBe("not enough to go on");
  });

  it("counts how many runs got there out of the ones that ended on their own", () => {
    const health = summarize([
      run({ id: "r1", status: "succeeded" }),
      run({ id: "r2", status: "succeeded" }),
      run({ id: "r3", status: "succeeded" }),
      run({ id: "r4", status: "failed" }),
    ]);

    expect(health.succeeded).toBe(3);
    expect(health.failed).toBe(1);
    expect(formatSuccessRate(health.successRate)).toBe("75%");
  });

  it("does not treat a run somebody stopped as a failure", () => {
    const health = summarize([
      run({ id: "r1", status: "succeeded" }),
      run({ id: "r2", status: "cancelled" }),
    ]);

    expect(health.stopped).toBe(1);
    expect(health.failed).toBe(0);
    expect(formatSuccessRate(health.successRate)).toBe("100%");
  });

  it("counts a timed-out run as a failure, because nobody chose it", () => {
    const health = summarize([
      run({ id: "r1", status: "succeeded" }),
      run({ id: "r2", status: "timed_out" }),
    ]);

    expect(health.failed).toBe(1);
    expect(formatSuccessRate(health.successRate)).toBe("50%");
  });

  it("leaves a run that is still going out of the success rate", () => {
    const health = summarize([
      run({ id: "r1", status: "succeeded" }),
      run({ id: "r2", status: "running", finishedAt: null }),
    ]);

    expect(health.live).toBe(1);
    expect(health.total).toBe(2);
    expect(formatSuccessRate(health.successRate)).toBe("100%");
  });

  it("reports the middle run's length, so one very long wait does not move it", () => {
    const health = summarize([
      run({
        id: "r1",
        status: "succeeded",
        startedAt: new Date(NOW - 10 * MIN),
        finishedAt: new Date(NOW - 9 * MIN),
      }),
      run({
        id: "r2",
        status: "succeeded",
        startedAt: new Date(NOW - 20 * MIN),
        finishedAt: new Date(NOW - 18 * MIN),
      }),
      run({
        id: "r3",
        status: "failed",
        startedAt: new Date(NOW - 5 * 60 * MIN),
        finishedAt: new Date(NOW - 60 * MIN),
      }),
    ]);

    expect(health.typicalDurationMs).toBe(2 * MIN);
  });

  it("ignores runs older than the window", () => {
    const health = summarize([
      run({ id: "r1", status: "succeeded" }),
      run({
        id: "old",
        status: "failed",
        startedAt: new Date(NOW - 30 * DAY),
        createdAt: new Date(NOW - 30 * DAY),
        finishedAt: new Date(NOW - 30 * DAY + MIN),
      }),
    ]);

    expect(health.total).toBe(1);
    expect(health.failed).toBe(0);
  });

  it("remembers when it last worked and when it last fell over", () => {
    const health = summarize([
      run({
        id: "r1",
        status: "succeeded",
        startedAt: new Date(NOW - 30 * MIN),
        finishedAt: new Date(NOW - 29 * MIN),
      }),
      run({
        id: "r2",
        status: "failed",
        startedAt: new Date(NOW - 90 * MIN),
        finishedAt: new Date(NOW - 89 * MIN),
      }),
    ]);

    expect(health.lastSuccessAt).toBe(new Date(NOW - 29 * MIN).toISOString());
    expect(health.lastFailureAt).toBe(new Date(NOW - 89 * MIN).toISOString());
  });

  it("takes a different window when asked for one", () => {
    const runs = [
      run({
        id: "r1",
        status: "succeeded",
        startedAt: new Date(NOW - 3 * DAY),
        createdAt: new Date(NOW - 3 * DAY),
        finishedAt: new Date(NOW - 3 * DAY + MIN),
      }),
    ];

    expect(summarizeAgentHealth(runs, { now: NOW, windowDays: 1 }).total).toBe(0);
    expect(summarizeAgentHealth(runs, { now: NOW, windowDays: 7 }).total).toBe(1);
  });
});
