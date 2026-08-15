import { describe, expect, it } from "vitest";
import {
  classifyClaudeFailure,
  detectClaudeLoginRequired,
  extractClaudeRateLimitEvent,
  extractClaudeRetryNotBefore,
  isClaudePlanExhaustedError,
  isClaudeTransientUpstreamError,
  parseClaudeStreamJson,
} from "./parse.js";

/**
 * The exact stream the CLI produced when a weekly limit ran out on
 * 2026-08-15, lifted verbatim from the run log at
 * ~/.paperclip/instances/default/data/run-logs/c613cfaf-.../c27f3705-....ndjson
 * (the 9KB system/init line is trimmed to its identifying fields; nothing else
 * is touched, including the middle dot in the prose).
 *
 * Two details here are the whole reason this fixture exists rather than a
 * hand-written string. `resetsAt` is epoch SECONDS, not milliseconds. And the
 * result carries `subtype: "success"` alongside `is_error: true`, which reads
 * like a contradiction and is exactly what the CLI sends.
 */
const REAL_WEEKLY_LIMIT_STDOUT = [
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "d3fd767e-3b87-4b4b-849c-ba83761b4ec1",
    model: "claude-sonnet-4-6",
    apiKeySource: "none",
    permissionMode: "bypassPermissions",
  }),
  JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "rejected",
      resetsAt: 1786950000,
      rateLimitType: "seven_day",
      overageStatus: "rejected",
      overageDisabledReason: "out_of_credits",
      isUsingOverage: false,
    },
    uuid: "10cd198f-e0d2-4476-bc59-9723352c6b4a",
    session_id: "d3fd767e-3b87-4b4b-849c-ba83761b4ec1",
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      id: "97ee1e9c-622c-494d-aaf2-27339b76ead8",
      model: "<synthetic>",
      role: "assistant",
      stop_reason: "stop_sequence",
      type: "message",
      content: [
        {
          type: "text",
          text: "You've hit your weekly limit · resets Aug 17, 3am (America/New_York)",
        },
      ],
    },
    session_id: "d3fd767e-3b87-4b4b-849c-ba83761b4ec1",
    error: "rate_limit",
    is_api_error_message: true,
  }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: true,
    api_error_status: 429,
    terminal_reason: "api_error",
    stop_reason: "stop_sequence",
    num_turns: 1,
    total_cost_usd: 0,
    session_id: "d3fd767e-3b87-4b4b-849c-ba83761b4ec1",
    result: "You've hit your weekly limit · resets Aug 17, 3am (America/New_York)",
  }),
].join("\n");

const REAL_WEEKLY_LIMIT_RESULT = parseClaudeStreamJson(REAL_WEEKLY_LIMIT_STDOUT).resultJson;

describe("detectClaudeLoginRequired", () => {
  it("classifies the 401 'Invalid authentication credentials' result as auth-required", () => {
    expect(
      detectClaudeLoginRequired({
        parsed: {
          is_error: true,
          api_error_status: 401,
          result: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
        },
        stdout: "",
        stderr: "",
      }).requiresLogin,
    ).toBe(true);
  });

  it("classifies a bare api_error_status 401 as auth-required even when the prose matches no phrase", () => {
    expect(
      detectClaudeLoginRequired({
        parsed: { is_error: true, api_error_status: 401, result: "Request failed." },
        stdout: "",
        stderr: "",
      }).requiresLogin,
    ).toBe(true);
  });

  it("matches both the legacy `claude login` and the new `claude auth login` phrasing", () => {
    expect(
      detectClaudeLoginRequired({
        parsed: null,
        stdout: "",
        stderr: "Please log in. Run `claude login` first.",
      }).requiresLogin,
    ).toBe(true);
    expect(
      detectClaudeLoginRequired({
        parsed: null,
        stdout: "Run `claude auth login` to authenticate.",
        stderr: "",
      }).requiresLogin,
    ).toBe(true);
  });

  it("does not flag a successful run as auth-required", () => {
    expect(
      detectClaudeLoginRequired({
        parsed: { is_error: false, result: "OK" },
        stdout: "",
        stderr: "",
      }).requiresLogin,
    ).toBe(false);
  });

  it("does not flag a 429 rate-limit as auth-required", () => {
    expect(
      detectClaudeLoginRequired({
        parsed: { is_error: true, api_error_status: 429, result: "Rate limited." },
        stdout: "",
        stderr: "",
      }).requiresLogin,
    ).toBe(false);
  });
});

describe("isClaudeTransientUpstreamError", () => {
  // Also flipped: running out of paid overage credit is the plan being spent,
  // not the provider being busy, so the same account keeps failing until reset.
  it("classifies the 'out of extra usage' failure as plan-exhausted, not transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)",
      }),
    ).toBe(false);
    expect(
      isClaudePlanExhaustedError({
        errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)",
      }),
    ).toBe(true);
    expect(
      isClaudePlanExhaustedError({
        parsed: {
          is_error: true,
          result: "You're out of extra usage. Resets at 4pm (America/Chicago).",
        },
      }),
    ).toBe(true);
  });

  it("classifies Anthropic API rate_limit_error and overloaded_error as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          errors: [{ type: "rate_limit_error", message: "Rate limit reached for requests." }],
        },
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          errors: [{ type: "overloaded_error", message: "Overloaded" }],
        },
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        stderr: "HTTP 429: Too Many Requests",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        stderr: "Bedrock ThrottlingException: slow down",
      }),
    ).toBe(true);
  });

  // These two used to assert `true`. A spent subscription window is now its own
  // family, because retrying the same account on a 2/10/30/120-minute ladder
  // cannot help when the window does not reopen for days.
  it("does NOT classify a spent subscription window as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "Claude usage limit reached. Weekly limit reached. Try again in 2 days.",
      }),
    ).toBe(false);
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "5-hour limit reached.",
      }),
    ).toBe(false);
    expect(
      isClaudePlanExhaustedError({
        errorMessage: "Claude usage limit reached. Weekly limit reached. Try again in 2 days.",
      }),
    ).toBe(true);
    expect(isClaudePlanExhaustedError({ errorMessage: "5-hour limit reached." })).toBe(true);
  });

  it("does not classify login/auth failures as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        stderr: "Please log in. Run `claude login` first.",
      }),
    ).toBe(false);
  });

  it("does not classify max-turns or unknown-session as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: { subtype: "error_max_turns", result: "Maximum turns reached." },
      }),
    ).toBe(false);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          result: "No conversation found with session id abc-123",
          errors: [{ message: "No conversation found with session id abc-123" }],
        },
      }),
    ).toBe(false);
  });

  it("does not classify deterministic validation errors as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "Invalid request_error: Unknown parameter 'foo'.",
      }),
    ).toBe(false);
  });
});

describe("classifyClaudeFailure against the real weekly-limit run", () => {
  it("reads the exact reset time out of the rate_limit_event", () => {
    const info = extractClaudeRateLimitEvent(REAL_WEEKLY_LIMIT_STDOUT);
    expect(info?.status).toBe("rejected");
    expect(info?.rateLimitType).toBe("seven_day");
    expect(info?.overageDisabledReason).toBe("out_of_credits");
    // Epoch SECONDS in the wire format, and the moment the prose describes as
    // "Aug 17, 3am (America/New_York)".
    expect(info?.resetsAt?.toISOString()).toBe("2026-08-17T07:00:00.000Z");
  });

  it("classifies the run as plan-exhausted with the window and the reset time", () => {
    const classification = classifyClaudeFailure({
      parsed: REAL_WEEKLY_LIMIT_RESULT,
      stdout: REAL_WEEKLY_LIMIT_STDOUT,
      stderr: "",
      errorMessage:
        "Claude run failed: subtype=success: You've hit your weekly limit · resets Aug 17, 3am (America/New_York)",
    });
    expect(classification).toEqual({
      family: "plan_exhausted",
      resetsAt: new Date("2026-08-17T07:00:00.000Z"),
      window: "seven_day",
    });
  });

  // The precedence test, and the reason classifyClaudeFailure exists at all.
  // This run carries api_error_status 429 in the parsed result AND in the raw
  // stdout the haystack is built from, so a transient-first classifier calls it
  // a blip and parks it on a two-minute ladder it can never climb out of.
  it("is NOT transient even though the run contains a bare 429", () => {
    expect(JSON.stringify(REAL_WEEKLY_LIMIT_RESULT)).toContain("429");
    expect(
      isClaudeTransientUpstreamError({
        parsed: REAL_WEEKLY_LIMIT_RESULT,
        stdout: REAL_WEEKLY_LIMIT_STDOUT,
      }),
    ).toBe(false);
  });

  it("hands the reset time to the scheduler as retryNotBefore", () => {
    expect(
      extractClaudeRetryNotBefore({
        parsed: REAL_WEEKLY_LIMIT_RESULT,
        stdout: REAL_WEEKLY_LIMIT_STDOUT,
      })?.toISOString(),
    ).toBe("2026-08-17T07:00:00.000Z");
  });

  it("keeps a genuine provider blip on the transient path", () => {
    expect(
      classifyClaudeFailure({
        parsed: { is_error: true, api_error_status: 429, result: "Overloaded. Try again later." },
        stdout: "",
      }),
    ).toEqual({ family: "transient_upstream", retryNotBefore: null });
  });

  // An informational event must not make an unrelated failure look transient.
  // The field name `rateLimitType` contains the text "rateLimit", so leaving
  // these lines in the prose haystack matched the transient pattern every time.
  it("ignores a rate_limit_event that was only a warning", () => {
    const stdout = JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", resetsAt: 1786950000, rateLimitType: "five_hour" },
    });
    expect(extractClaudeRateLimitEvent(stdout)?.status).toBe("allowed");
    expect(classifyClaudeFailure({ parsed: { is_error: true, result: "Boom" }, stdout })).toBeNull();
  });

  it("still sees a real rate-limit message that shares a line with the event", () => {
    const stdout = [
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed", resetsAt: 1786950000, rateLimitType: "five_hour" },
      }),
      "API Error: 429 Too Many Requests",
    ].join("\n");
    expect(classifyClaudeFailure({ parsed: { is_error: true, result: "Boom" }, stdout })).toEqual({
      family: "transient_upstream",
      retryNotBefore: null,
    });
  });

  it("prefers a rejection over an earlier warning in the same run", () => {
    const stdout = [
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: { status: "warning", resetsAt: 1786000000, rateLimitType: "seven_day" },
      }),
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", resetsAt: 1786950000, rateLimitType: "seven_day" },
      }),
    ].join("\n");
    expect(extractClaudeRateLimitEvent(stdout)?.status).toBe("rejected");
    expect(extractClaudeRateLimitEvent(stdout)?.resetsAt?.toISOString()).toBe(
      "2026-08-17T07:00:00.000Z",
    );
  });

  it("still lets a login failure win over a rate-limit rejection", () => {
    expect(
      classifyClaudeFailure({
        parsed: { is_error: true, api_error_status: 401, result: "Invalid authentication credentials" },
        stdout: REAL_WEEKLY_LIMIT_STDOUT,
      }),
    ).toBeNull();
  });
});

describe("extractClaudeRetryNotBefore", () => {
  it("parses the 'resets 4pm' hint in its explicit timezone", () => {
    const now = new Date("2026-04-22T15:15:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)" },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-04-22T21:00:00.000Z");
  });

  it("rolls forward past midnight when the reset time has already passed today", () => {
    const now = new Date("2026-04-22T23:30:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "Usage limit reached. Resets at 3:15 AM (UTC)." },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-04-23T03:15:00.000Z");
  });

  it("returns null when no reset hint is present", () => {
    expect(
      extractClaudeRetryNotBefore({ errorMessage: "Overloaded. Try again later." }, new Date()),
    ).toBeNull();
  });
});
