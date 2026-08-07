import { describe, expect, it } from "vitest";
import { decideHostClaudeTokenRestore } from "../adapters/registry.js";

/**
 * The decision behind putting the machine's Claude sign-in back after a restart.
 *
 * The live case this came from: a token saved to the Windows user environment
 * and valid until 2027 was invisible to every agent for three days, because the
 * server had been started from a Claude Code context. Ten agents across several
 * companies failed to sign in; the one agent that had been given its own token
 * carried on working.
 */

const NOW = Date.parse("2026-08-07T16:00:00.000Z");
const NEXT_YEAR = "2027-08-05T18:38:21.393Z";
const LAST_YEAR = "2025-08-05T18:38:21.393Z";

function decide(overrides: Parameters<typeof decideHostClaudeTokenRestore>[0]) {
  return decideHostClaudeTokenRestore(overrides);
}

describe("decideHostClaudeTokenRestore", () => {
  it("puts back a saved token the restart lost", () => {
    // The whole point.
    const result = decide({
      currentToken: null,
      savedToken: "sk-ant-oat01-abc",
      savedExpiresAt: NEXT_YEAR,
      hasLaunchMarkers: true,
      nowMs: NOW,
    });
    expect(result.action).toBe("adopt-saved-token");
    expect(result.reason).toContain(NEXT_YEAR);
  });

  it("puts it back even when nothing stripped it, because it is still missing", () => {
    const result = decide({
      currentToken: null,
      savedToken: "sk-ant-oat01-abc",
      savedExpiresAt: NEXT_YEAR,
      hasLaunchMarkers: false,
      nowMs: NOW,
    });
    expect(result.action).toBe("adopt-saved-token");
  });

  it("clears the launch markers when a token is already there but hidden", () => {
    // A real token inherited alongside Claude Code's markers is dropped on its
    // way to an agent. The token needs no repair; the markers do.
    const result = decide({
      currentToken: "sk-ant-oat01-live",
      savedToken: "sk-ant-oat01-saved",
      savedExpiresAt: NEXT_YEAR,
      hasLaunchMarkers: true,
      nowMs: NOW,
    });
    expect(result.action).toBe("unblock-inherited-token");
  });

  it("never overwrites a token that is already working", () => {
    // This is a repair, not an override. Whatever put the token there - a
    // deliberate export, a launcher, an earlier paste - keeps precedence.
    const result = decide({
      currentToken: "sk-ant-oat01-live",
      savedToken: "sk-ant-oat01-different",
      savedExpiresAt: NEXT_YEAR,
      hasLaunchMarkers: false,
      nowMs: NOW,
    });
    expect(result.action).toBe("none");
  });

  it("leaves a saved token that has run out, and says when it ran out", () => {
    // Using it would fail every run identically and silently, which is the
    // failure this whole change exists to end.
    const result = decide({
      currentToken: null,
      savedToken: "sk-ant-oat01-stale",
      savedExpiresAt: LAST_YEAR,
      hasLaunchMarkers: true,
      nowMs: NOW,
    });
    expect(result.action).toBe("none");
    expect(result.reason).toContain(LAST_YEAR);
    expect(result.reason).toContain("Sign in again");
  });

  it("uses a saved token whose expiry was never recorded", () => {
    // Older saves predate the expiry stamp. An unknown expiry is not a reason
    // to withhold a token that may well be fine.
    const result = decide({
      currentToken: null,
      savedToken: "sk-ant-oat01-abc",
      savedExpiresAt: null,
      hasLaunchMarkers: false,
      nowMs: NOW,
    });
    expect(result.action).toBe("adopt-saved-token");
  });

  it("uses a saved token whose recorded expiry is gibberish", () => {
    // Refusing to sign in because a string did not parse would be worse than
    // trying the token and letting the run report the truth.
    const result = decide({
      currentToken: null,
      savedToken: "sk-ant-oat01-abc",
      savedExpiresAt: "not-a-date",
      hasLaunchMarkers: false,
      nowMs: NOW,
    });
    expect(result.action).toBe("adopt-saved-token");
  });

  it("does nothing when there is nothing saved", () => {
    // The ordinary case on a machine that has never pasted a token, and on
    // every platform where nothing is persisted.
    const result = decide({
      currentToken: null,
      savedToken: null,
      savedExpiresAt: null,
      hasLaunchMarkers: true,
      nowMs: NOW,
    });
    expect(result.action).toBe("none");
    expect(result.reason).toContain("No saved Claude token");
  });

  it("treats whitespace as absent on both sides", () => {
    expect(
      decide({
        currentToken: "   ",
        savedToken: "  ",
        savedExpiresAt: null,
        hasLaunchMarkers: false,
        nowMs: NOW,
      }).action,
    ).toBe("none");

    expect(
      decide({
        currentToken: "  \n ",
        savedToken: " sk-ant-oat01-abc ",
        savedExpiresAt: NEXT_YEAR,
        hasLaunchMarkers: false,
        nowMs: NOW,
      }).action,
    ).toBe("adopt-saved-token");
  });

  it("counts a token expiring in a second as still usable", () => {
    // The boundary is "has run out", not "is about to".
    expect(
      decide({
        currentToken: null,
        savedToken: "sk-ant-oat01-abc",
        savedExpiresAt: new Date(NOW + 1000).toISOString(),
        hasLaunchMarkers: false,
        nowMs: NOW,
      }).action,
    ).toBe("adopt-saved-token");

    expect(
      decide({
        currentToken: null,
        savedToken: "sk-ant-oat01-abc",
        savedExpiresAt: new Date(NOW).toISOString(),
        hasLaunchMarkers: false,
        nowMs: NOW,
      }).action,
    ).toBe("none");
  });
});
