import { describe, expect, it } from "vitest";
import {
  CLAUDE_ACCOUNT_SWITCH_COOLDOWN_MS,
  EMPTY_CLAUDE_ACCOUNT_STATE,
  activeClaudeAccount,
  applyClaudeAccountSwitch,
  claudeAccountSwitchDecision,
  describeClaudeAccounts,
  forgetExpiredClaudeAccountLimits,
  type ClaudeAccountState,
} from "../claude-account-router.js";

const NOW = Date.parse("2026-08-15T15:00:00.000Z");
/** The real reset the CLI reported when a weekly window ran out. */
const AUG_17_RESET = Date.parse("2026-08-17T07:00:00.000Z");

function stateWith(overrides: Partial<ClaudeAccountState> = {}): ClaudeAccountState {
  return {
    slots: [
      { slot: "1", token: "sk-ant-oat01-one", label: "Main" },
      { slot: "2", token: "sk-ant-oat01-two", label: "Backup" },
    ],
    activeSlot: "1",
    lastSwitch: null,
    exhaustedUntil: {},
    ...overrides,
  };
}

describe("activeClaudeAccount", () => {
  it("returns null when nothing is configured, leaving the single sign-in alone", () => {
    expect(activeClaudeAccount(EMPTY_CLAUDE_ACCOUNT_STATE)).toBeNull();
  });

  it("picks the recorded active account", () => {
    expect(activeClaudeAccount(stateWith({ activeSlot: "2" }))?.label).toBe("Backup");
  });

  it("falls back to the first usable account when the active one is gone or disabled", () => {
    expect(activeClaudeAccount(stateWith({ activeSlot: "gone" }))?.slot).toBe("1");
    expect(
      activeClaudeAccount(
        stateWith({
          slots: [
            { slot: "1", token: "sk-ant-oat01-one", label: "Main", enabled: false },
            { slot: "2", token: "sk-ant-oat01-two", label: "Backup" },
          ],
        }),
      )?.slot,
    ).toBe("2");
  });

  it("ignores an account with no token", () => {
    expect(
      activeClaudeAccount(
        stateWith({ slots: [{ slot: "1", token: "   ", label: "half-added" }], activeSlot: "1" }),
      ),
    ).toBeNull();
  });
});

describe("claudeAccountSwitchDecision", () => {
  it("does nothing for a transient failure, so a busy provider never rotates accounts", () => {
    expect(
      claudeAccountSwitchDecision({
        state: stateWith(),
        ranOn: "1",
        family: "transient_upstream",
        resetsAt: null,
        now: NOW,
      }),
    ).toBeNull();
  });

  it("does nothing when the failure is neither family", () => {
    expect(
      claudeAccountSwitchDecision({
        state: stateWith(),
        ranOn: "1",
        family: null,
        resetsAt: null,
        now: NOW,
      }),
    ).toBeNull();
  });

  it("does nothing for a run that signed in with its own pinned token", () => {
    expect(
      claudeAccountSwitchDecision({
        state: stateWith(),
        ranOn: null,
        family: "plan_exhausted",
        resetsAt: AUG_17_RESET,
        now: NOW,
      }),
    ).toBeNull();
  });

  it("moves to the standby account when the plan is spent", () => {
    expect(
      claudeAccountSwitchDecision({
        state: stateWith(),
        ranOn: "1",
        family: "plan_exhausted",
        resetsAt: AUG_17_RESET,
        now: NOW,
      }),
    ).toEqual({ kind: "switch", to: "2", from: "1" });
  });

  it("adopts the account a concurrent run already moved to, without moving again", () => {
    expect(
      claudeAccountSwitchDecision({
        state: stateWith({
          activeSlot: "2",
          lastSwitch: { at: NOW - 1_000, from: "1", to: "2" },
        }),
        ranOn: "1",
        family: "plan_exhausted",
        resetsAt: AUG_17_RESET,
        now: NOW,
      }),
    ).toEqual({ kind: "adopt", to: "2" });
  });

  it("reports exhausted when the only other account is out until its own reset", () => {
    expect(
      claudeAccountSwitchDecision({
        state: stateWith({ exhaustedUntil: { "2": AUG_17_RESET } }),
        ranOn: "1",
        family: "plan_exhausted",
        resetsAt: AUG_17_RESET,
        now: NOW,
      }),
    ).toEqual({ kind: "exhausted", resetsAt: AUG_17_RESET });
  });

  it("will not flap back to an account it just left, until the cooldown passes", () => {
    const justLeft = stateWith({
      activeSlot: "2",
      lastSwitch: { at: NOW - 1_000, from: "1", to: "2" },
    });
    // Account 2 has now failed too. Account 1 was abandoned a second ago, so
    // with no reset times known this is "both are out", not a ping-pong.
    expect(
      claudeAccountSwitchDecision({
        state: justLeft,
        ranOn: "2",
        family: "plan_exhausted",
        resetsAt: null,
        now: NOW,
      })?.kind,
    ).toBe("exhausted");

    // Once the cooldown has passed, account 1 is worth trying again.
    expect(
      claudeAccountSwitchDecision({
        state: justLeft,
        ranOn: "2",
        family: "plan_exhausted",
        resetsAt: null,
        now: NOW + CLAUDE_ACCOUNT_SWITCH_COOLDOWN_MS + 1,
      }),
    ).toEqual({ kind: "switch", to: "1", from: "2" });
  });

  it("skips an account that is out and picks it up once its reset has passed", () => {
    const threeAccounts = stateWith({
      slots: [
        { slot: "1", token: "sk-ant-oat01-one", label: "one" },
        { slot: "2", token: "sk-ant-oat01-two", label: "two" },
        { slot: "3", token: "sk-ant-oat01-three", label: "three" },
      ],
      exhaustedUntil: { "2": NOW + 60_000 },
    });
    expect(
      claudeAccountSwitchDecision({
        state: threeAccounts,
        ranOn: "1",
        family: "plan_exhausted",
        resetsAt: AUG_17_RESET,
        now: NOW,
      }),
    ).toEqual({ kind: "switch", to: "3", from: "1" });

    expect(
      claudeAccountSwitchDecision({
        state: threeAccounts,
        ranOn: "1",
        family: "plan_exhausted",
        resetsAt: AUG_17_RESET,
        now: NOW + 60_001,
      }),
    ).toEqual({ kind: "switch", to: "2", from: "1" });
  });

  it("walks a three-account list one at a time rather than stopping after two", () => {
    let state = stateWith({
      slots: [
        { slot: "1", token: "sk-ant-oat01-one", label: "one" },
        { slot: "2", token: "sk-ant-oat01-two", label: "two" },
        { slot: "3", token: "sk-ant-oat01-three", label: "three" },
      ],
    });
    const visited: string[] = [];
    for (let step = 0; step < 3; step += 1) {
      const ranOn = activeClaudeAccount(state)?.slot ?? null;
      visited.push(ranOn ?? "none");
      const decision = claudeAccountSwitchDecision({
        state,
        ranOn,
        family: "plan_exhausted",
        resetsAt: AUG_17_RESET,
        now: NOW + step,
      });
      state = applyClaudeAccountSwitch({
        state,
        decision,
        ranOn,
        resetsAt: AUG_17_RESET,
        now: NOW + step,
      });
      if (decision?.kind === "exhausted") break;
    }
    expect(visited).toEqual(["1", "2", "3"]);
    expect(
      claudeAccountSwitchDecision({
        state,
        ranOn: "3",
        family: "plan_exhausted",
        resetsAt: AUG_17_RESET,
        now: NOW + 3,
      }),
    ).toEqual({ kind: "exhausted", resetsAt: AUG_17_RESET });
  });
});

describe("applyClaudeAccountSwitch", () => {
  it("records the move and marks the spent account out until its reset", () => {
    const next = applyClaudeAccountSwitch({
      state: stateWith(),
      decision: { kind: "switch", to: "2", from: "1" },
      ranOn: "1",
      resetsAt: AUG_17_RESET,
      now: NOW,
    });
    expect(next.activeSlot).toBe("2");
    expect(next.lastSwitch).toEqual({ at: NOW, from: "1", to: "2" });
    expect(next.exhaustedUntil["1"]).toBe(AUG_17_RESET);
  });

  it("leaves the active account alone when a concurrent run already moved it", () => {
    const state = stateWith({ activeSlot: "2" });
    const next = applyClaudeAccountSwitch({
      state,
      decision: { kind: "adopt", to: "2" },
      ranOn: "1",
      resetsAt: AUG_17_RESET,
      now: NOW,
    });
    expect(next.activeSlot).toBe("2");
    expect(next.lastSwitch).toBeNull();
  });

  it("falls back to a cooldown-length block when no reset time is known", () => {
    const next = applyClaudeAccountSwitch({
      state: stateWith(),
      decision: { kind: "exhausted", resetsAt: null },
      ranOn: "1",
      resetsAt: null,
      now: NOW,
    });
    expect(next.exhaustedUntil["1"]).toBe(NOW + CLAUDE_ACCOUNT_SWITCH_COOLDOWN_MS);
  });
});

describe("describeClaudeAccounts", () => {
  it("names the active account and the standbys, and never leaks a token", () => {
    const described = describeClaudeAccounts(
      stateWith({ exhaustedUntil: { "2": AUG_17_RESET } }),
      NOW,
    );
    expect(described).toContain("Main (active)");
    expect(described).toContain("Backup (out until 2026-08-17T07:00:00.000Z)");
    expect(described).not.toContain("sk-ant");
  });

  it("says so plainly when nothing is configured", () => {
    expect(describeClaudeAccounts(EMPTY_CLAUDE_ACCOUNT_STATE, NOW)).toBe(
      "No Claude accounts configured",
    );
  });
});

describe("forgetExpiredClaudeAccountLimits", () => {
  it("clears a window that reopened while nothing was running", () => {
    const state = stateWith({ exhaustedUntil: { "1": NOW - 1, "2": AUG_17_RESET } });
    expect(forgetExpiredClaudeAccountLimits(state, NOW).exhaustedUntil).toEqual({
      "2": AUG_17_RESET,
    });
  });

  it("returns the same object when there is nothing to clear", () => {
    const state = stateWith({ exhaustedUntil: { "2": AUG_17_RESET } });
    expect(forgetExpiredClaudeAccountLimits(state, NOW)).toBe(state);
  });
});
