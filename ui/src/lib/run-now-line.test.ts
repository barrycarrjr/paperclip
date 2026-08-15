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

  // A spent Claude plan parks work for days, not minutes. "Will retry Sunday"
  // in the ordinary warning tone reads like a blip, so the cause is named and a
  // long wait is treated as something to look at.
  it("names a Claude limit and escalates the tone when the wait is long", () => {
    const line = runNowLine(
      {
        status: "scheduled_retry",
        scheduledRetryAt: new Date(NOW + 40 * 3600_000).toISOString(),
        scheduledRetryAttempt: 1,
        scheduledRetryReason: "claude_plan_exhausted",
      },
      NOW,
    );
    expect(line?.text).toMatch(/^Waiting for Claude limit reset /);
    expect(line?.tone).toBe("err");
    expect(line?.title).toContain("Claude plan limit");
  });

  it("keeps a short Claude limit wait in the ordinary tone", () => {
    const line = runNowLine(
      {
        status: "scheduled_retry",
        scheduledRetryAt: new Date(NOW + 30 * 60_000).toISOString(),
        scheduledRetryAttempt: 1,
        scheduledRetryReason: "claude_plan_exhausted",
      },
      NOW,
    );
    expect(line?.tone).toBe("warn");
  });

  it("reads an account switch as an ordinary retry, because it is one", () => {
    const line = runNowLine(
      {
        status: "scheduled_retry",
        scheduledRetryAt: new Date(NOW + 30_000).toISOString(),
        scheduledRetryAttempt: 1,
        scheduledRetryReason: "claude_account_failover",
      },
      NOW,
    );
    expect(line?.text).toMatch(/^Will retry /);
    expect(line?.tone).toBe("warn");
    expect(line?.title).toContain("Switched Claude account");
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
