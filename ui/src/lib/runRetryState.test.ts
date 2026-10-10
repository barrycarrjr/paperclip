import { describe, expect, it } from "vitest";
import { buildRetryWakePayload, describeRunRetryState, formatRetryReason } from "./runRetryState";

describe("buildRetryWakePayload", () => {
  // The server reads the run back to put the retry in that run's
  // conversation; without it a retried Slack or scheduled run starts over.
  it("names the run being retried even when it had no task", () => {
    expect(
      buildRetryWakePayload({
        id: "run-1",
        contextSnapshot: { wakeSource: "automation", pluginKey: "slack-tools" },
      }),
    ).toEqual({ retryOfRunId: "run-1" });
    expect(buildRetryWakePayload({ id: "run-2", contextSnapshot: null })).toEqual({ retryOfRunId: "run-2" });
  });

  it("keeps the run's task", () => {
    expect(
      buildRetryWakePayload({
        id: "run-1",
        contextSnapshot: { issueId: "issue-1", taskId: "issue-1", taskKey: "issue-1", wakeReason: "issue_commented" },
      }),
    ).toEqual({ retryOfRunId: "run-1", issueId: "issue-1", taskId: "issue-1", taskKey: "issue-1" });
  });
});

describe("runRetryState", () => {
  it("formats internal retry reasons for operators", () => {
    expect(formatRetryReason("transient_failure")).toBe("Transient failure");
    expect(formatRetryReason("issue_continuation_needed")).toBe("Continuation needed");
    expect(formatRetryReason("custom_reason")).toBe("custom reason");
  });

  it("describes scheduled retries", () => {
    expect(
      describeRunRetryState({
        status: "scheduled_retry",
        retryOfRunId: "run-1",
        scheduledRetryAttempt: 2,
        scheduledRetryReason: "transient_failure",
        scheduledRetryAt: "2026-04-18T20:15:00.000Z",
      }),
    ).toMatchObject({
      kind: "scheduled",
      badgeLabel: "Retry scheduled",
      detail: "Attempt 2 · Transient failure",
    });
  });

  it("describes exhausted retries", () => {
    expect(
      describeRunRetryState({
        status: "failed",
        retryOfRunId: "run-1",
        scheduledRetryAttempt: 4,
        scheduledRetryReason: "transient_failure",
        retryExhaustedReason: "Bounded retry exhausted after 4 scheduled attempts; no further automatic retry will be queued",
      }),
    ).toMatchObject({
      kind: "exhausted",
      badgeLabel: "Retry exhausted",
      detail: "Attempt 4 · Transient failure · Automatic retries exhausted",
      secondary: "Bounded retry exhausted after 4 scheduled attempts; no further automatic retry will be queued Manual intervention required.",
    });
  });
});
