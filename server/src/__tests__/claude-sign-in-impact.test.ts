import { describe, expect, it } from "vitest";
import { agentHasOwnClaudeToken } from "../services/claude-sign-in-impact.js";

/**
 * Whether an agent carries its own Claude token decides what the failure page
 * tells the operator: fix the machine's sign-in, or replace this agent's token.
 * Getting it wrong sends them to the wrong place, so the shape is pinned here.
 */
describe("agentHasOwnClaudeToken", () => {
  it("recognises the binding the setup-token route actually writes", () => {
    expect(
      agentHasOwnClaudeToken({
        env: {
          CLAUDE_CODE_OAUTH_TOKEN: { type: "secret_ref", secretId: "sec-1", version: "latest" },
        },
      }),
    ).toBe(true);
  });

  it("recognises a token set directly rather than through a secret", () => {
    expect(
      agentHasOwnClaudeToken({ env: { CLAUDE_CODE_OAUTH_TOKEN: { type: "plain", value: "sk-x" } } }),
    ).toBe(true);
    expect(agentHasOwnClaudeToken({ env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-x" } })).toBe(true);
  });

  it("treats an agent with no binding as sharing the machine's sign-in", () => {
    // The common case: 62 of 63 agents on the machine this came from.
    expect(agentHasOwnClaudeToken({ env: { SOMETHING_ELSE: "x" } })).toBe(false);
    expect(agentHasOwnClaudeToken({ env: {} })).toBe(false);
    expect(agentHasOwnClaudeToken({})).toBe(false);
    expect(agentHasOwnClaudeToken(null)).toBe(false);
    expect(agentHasOwnClaudeToken(undefined)).toBe(false);
  });

  it("treats an emptied binding as no binding", () => {
    // An empty CLAUDE_CODE_OAUTH_TOKEN is how the spawn code is told to force
    // the token OFF, so it is the opposite of having one.
    expect(agentHasOwnClaudeToken({ env: { CLAUDE_CODE_OAUTH_TOKEN: "" } })).toBe(false);
    expect(agentHasOwnClaudeToken({ env: { CLAUDE_CODE_OAUTH_TOKEN: "   " } })).toBe(false);
    expect(
      agentHasOwnClaudeToken({ env: { CLAUDE_CODE_OAUTH_TOKEN: { type: "plain", value: "" } } }),
    ).toBe(false);
  });

  it("does not treat a malformed binding as a working token", () => {
    // Claiming the agent has its own token when it does not would tell the
    // operator the machine is fine when it is the whole problem.
    expect(
      agentHasOwnClaudeToken({ env: { CLAUDE_CODE_OAUTH_TOKEN: { type: "secret_ref" } } }),
    ).toBe(false);
    expect(agentHasOwnClaudeToken({ env: { CLAUDE_CODE_OAUTH_TOKEN: { type: "mystery" } } })).toBe(
      false,
    );
    expect(agentHasOwnClaudeToken({ env: { CLAUDE_CODE_OAUTH_TOKEN: 42 } })).toBe(false);
  });
});
