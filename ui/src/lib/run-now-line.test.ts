import { describe, expect, it } from "vitest";
import { runNowLine } from "./run-now-line";

const NOW = 1_754_000_000_000;

describe("runNowLine", () => {
  it("says when a self-healing run will retry", () => {
    const line = runNowLine(
      {
        status: "scheduled_retry",
        scheduledRetryAt: new Date(NOW + 10 * 60_000).toISOString(),
        scheduledRetryAttempt: 2,
        scheduledRetryReason: "transient_failure",
      },
      NOW,
    );
    expect(line?.text).toMatch(/^Will retry /);
    expect(line?.tone).toBe("warn");
    expect(line?.title).toContain("Attempt 2");
  });

  it("flags a running run that has gone quiet", () => {
    const line = runNowLine(
      {
        status: "running",
        outputSilence: {
          level: "critical",
          silenceStartedAt: new Date(NOW - 4.5 * 3600_000).toISOString(),
        } as never,
      },
      NOW,
    );
    expect(line?.text).toMatch(/^Quiet for 4h/);
    expect(line?.tone).toBe("err");
  });

  it("stays silent for a running run with nothing to report", () => {
    expect(runNowLine({ status: "running" }, NOW)).toBeNull();
  });

  it("labels queued runs plainly", () => {
    expect(runNowLine({ status: "queued" }, NOW)?.text).toBe("Waiting for a free slot");
  });

  it("translates the finished liveness verdict into plain words", () => {
    const line = runNowLine({ status: "succeeded", livenessState: "plan_only" }, NOW);
    expect(line?.text).toBe("Only planned, took no action");
    expect(line?.tone).toBe("warn");
  });
});
