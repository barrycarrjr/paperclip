import { describe, expect, it } from "vitest";
import { extractClaudeSetupToken, redactSetupToken } from "./execute.js";

// Synthetic token of the real `sk-ant-oat01-…` shape — never embed a live token.
const SAMPLE = "sk-ant-oat01-EXAMPLEonly0123456789_abcDEF-ghiJKL-mnoPQR-stuVWXyz";

describe("extractClaudeSetupToken", () => {
  it("pulls the token out of real-shaped setup-token output", () => {
    const out =
      "Long-lived authentication token created successfully!\n" +
      "Your OAuth token (valid for 1 year):\n" +
      `${SAMPLE}\n` +
      "Store this token securely. You won't be able to see it again.\n" +
      "Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>";
    expect(extractClaudeSetupToken(out)).toBe(SAMPLE);
  });

  it("returns null when no token is present (e.g. a 401 / cancelled sign-in)", () => {
    expect(extractClaudeSetupToken("Failed to authenticate. API Error: 401")).toBeNull();
  });
});

describe("redactSetupToken", () => {
  it("redacts every token occurrence so it is safe to log", () => {
    const redacted = redactSetupToken(`token=${SAMPLE} and again: ${SAMPLE}`);
    expect(redacted).not.toContain(SAMPLE);
    expect(redacted).not.toContain("EXAMPLEonly0123456789");
    expect(redacted).toContain("sk-ant-oat01-***REDACTED***");
    expect(redacted.match(/\*\*\*REDACTED\*\*\*/g)).toHaveLength(2);
  });

  it("leaves token-free text unchanged", () => {
    expect(redactSetupToken("nothing secret here")).toBe("nothing secret here");
  });
});
