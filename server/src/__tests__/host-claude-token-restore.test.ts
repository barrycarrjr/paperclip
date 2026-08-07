import { describe, expect, it } from "vitest";
import { decideHostClaudeTokenRestore, isLongLivedClaudeToken } from "../adapters/registry.js";

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

/** Shaped like the real thing: `claude setup-token` output is long. */
const LONG_LIVED = "sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const LONG_LIVED_SAVED = "sk-ant-oat01-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
/** What Claude Desktop injects into its own children. Not usable by an agent. */
const DESKTOP_SESSION = "sk-ant-sid01-desktop-session-value";

function decide(overrides: Parameters<typeof decideHostClaudeTokenRestore>[0]) {
  return decideHostClaudeTokenRestore(overrides);
}

describe("decideHostClaudeTokenRestore", () => {
  it("puts back a saved token the restart lost", () => {
    // The whole point.
    const result = decide({
      currentToken: null,
      savedToken: LONG_LIVED_SAVED,
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
      savedToken: LONG_LIVED_SAVED,
      savedExpiresAt: NEXT_YEAR,
      hasLaunchMarkers: false,
      nowMs: NOW,
    });
    expect(result.action).toBe("adopt-saved-token");
  });

  it("clears the launch markers when a good token is already there but hidden", () => {
    // A long-lived token inherited alongside Claude Code's markers is dropped on
    // its way to an agent. The token needs no repair; the markers do.
    const result = decide({
      currentToken: LONG_LIVED,
      savedToken: LONG_LIVED_SAVED,
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
      currentToken: LONG_LIVED,
      savedToken: LONG_LIVED_SAVED,
      savedExpiresAt: NEXT_YEAR,
      hasLaunchMarkers: false,
      nowMs: NOW,
    });
    expect(result.action).toBe("none");
  });

  it("does not unblock Claude Desktop's own session token", () => {
    // The one that would have recreated the outage. Those markers are how the
    // spawn code recognises a desktop session token, which an agent cannot use -
    // it comes back 401. Dropping them would hand every agent that dead token
    // AND hide the machine's working stored login behind it.
    const result = decide({
      currentToken: DESKTOP_SESSION,
      savedToken: null,
      savedExpiresAt: null,
      hasLaunchMarkers: true,
      nowMs: NOW,
    });
    expect(result.action).toBe("none");
    expect(result.reason).toContain("Claude Code session");
  });

  it("replaces a desktop session token with the saved long-lived one", () => {
    // Exactly the machine this came from: started from the desktop app, so the
    // environment carries a token agents cannot use, while a good one sits saved.
    const result = decide({
      currentToken: DESKTOP_SESSION,
      savedToken: LONG_LIVED_SAVED,
      savedExpiresAt: NEXT_YEAR,
      hasLaunchMarkers: true,
      nowMs: NOW,
    });
    expect(result.action).toBe("adopt-saved-token");
  });

  it("will not swap a working environment for an unusable saved token", () => {
    const result = decide({
      currentToken: null,
      savedToken: "some-other-kind-of-secret",
      savedExpiresAt: NEXT_YEAR,
      hasLaunchMarkers: true,
      nowMs: NOW,
    });
    expect(result.action).toBe("none");
    expect(result.reason).toContain("setup-token");
  });

  it("leaves a saved token that has run out, and says when it ran out", () => {
    // Using it would fail every run identically and silently, which is the
    // failure this whole change exists to end.
    const result = decide({
      currentToken: null,
      savedToken: LONG_LIVED_SAVED,
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
      savedToken: LONG_LIVED_SAVED,
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
      savedToken: LONG_LIVED_SAVED,
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

  it("knows a setup token from a desktop session token", () => {
    expect(isLongLivedClaudeToken(LONG_LIVED)).toBe(true);
    expect(isLongLivedClaudeToken(DESKTOP_SESSION)).toBe(false);
    expect(isLongLivedClaudeToken("sk-ant-oat01-tooshort")).toBe(false);
    expect(isLongLivedClaudeToken("")).toBe(false);
    expect(isLongLivedClaudeToken(null)).toBe(false);
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
        savedToken: ` ${LONG_LIVED_SAVED} `,
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
        savedToken: LONG_LIVED_SAVED,
        savedExpiresAt: new Date(NOW + 1000).toISOString(),
        hasLaunchMarkers: false,
        nowMs: NOW,
      }).action,
    ).toBe("adopt-saved-token");

    expect(
      decide({
        currentToken: null,
        savedToken: LONG_LIVED_SAVED,
        savedExpiresAt: new Date(NOW).toISOString(),
        hasLaunchMarkers: false,
        nowMs: NOW,
      }).action,
    ).toBe("none");
  });
});
