import { describe, expect, it } from "vitest";
import { ADAPTERS_SETTINGS_PATH, explainAgentError } from "./agent-error-explanation";

const SEEN_LIVE =
  "Claude run failed: subtype=success: Failed to authenticate: OAuth session expired and could not be refreshed";

describe("explainAgentError", () => {
  it("turns the expired sign-in seen on the Team page into plain words", () => {
    const explained = explainAgentError(SEEN_LIVE, "claude_local");

    expect(explained).not.toBeNull();
    expect(explained!.summary).toBe("Its last run could not sign in to Claude.");
    expect(explained!.hint).toBe("Try again. If it fails again, sign in again under");
    expect(explained!.fixLink).toEqual({ label: "Adapters", to: ADAPTERS_SETTINGS_PATH });
    expect(explained!.raw).toBe(SEEN_LIVE);
  });

  it("points at the instance Adapters settings page", () => {
    expect(ADAPTERS_SETTINGS_PATH).toBe("/instance/settings/adapters");
  });

  it.each([
    "OAuth session expired",
    "Failed to authenticate. API Error: 401 OAuth access token is invalid.",
    "API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\"}}",
    "Request failed with status code 401",
    "HTTP 401 Unauthorized",
  ])("recognises a sign-in failure worded as %j", (raw) => {
    expect(explainAgentError(raw, "claude_local")?.summary).toBe(
      "Its last run could not sign in to Claude.",
    );
  });

  it("names the provider the agent actually runs on", () => {
    expect(explainAgentError("HTTP 401 Unauthorized", "codex_local")?.summary).toBe(
      "Its last run could not sign in to Codex.",
    );
  });

  it.each(["gemini_local", "process", "http", "cursor", "opencode_local", null, undefined])(
    "leaves a sign-in failure alone for %s, whose sign-in the Adapters page cannot redo",
    (adapterType) => {
      expect(explainAgentError(SEEN_LIVE, adapterType)).toBeNull();
      expect(explainAgentError("HTTP 401 Unauthorized", adapterType)).toBeNull();
    },
  );

  it.each([
    "Adapter exited with code 1",
    "Tests failed",
    // A task number is not a status code.
    "Could not update PER-401: token budget reached",
    "Wrote 401 lines of output",
  ])("leaves an error it does not recognise alone: %j", (raw) => {
    expect(explainAgentError(raw, "claude_local")).toBeNull();
  });

  it("says nothing when nothing was recorded", () => {
    expect(explainAgentError(null, "claude_local")).toBeNull();
    expect(explainAgentError("   ", "claude_local")).toBeNull();
  });
});
