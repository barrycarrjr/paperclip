import { describe, expect, it } from "vitest";
import {
  detectClaudeLoginRequired,
  extractClaudeRetryNotBefore,
  isClaudeTransientUpstreamError,
} from "./parse.js";

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
  it("classifies the 'out of extra usage' subscription window failure as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
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

  it("classifies the subscription 5-hour / weekly limit wording", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "Claude usage limit reached — weekly limit reached. Try again in 2 days.",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "5-hour limit reached.",
      }),
    ).toBe(true);
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
