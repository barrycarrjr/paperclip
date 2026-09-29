import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SwitchboardAnswer } from "../switchboard.js";

/**
 * Switchboard's answer is stubbed at the module boundary, the same way
 * chat-account-routing.test.ts does it, so what the machine running the suite
 * has installed cannot leak in. Forgetting an account is stubbed too, so the
 * tests can see what was asked to be forgotten. Everything else in
 * switchboard.ts is the real thing, so the environment built for a chosen
 * account, and the check for a run's own sign-in, are the real ones.
 */
const answer = vi.hoisted(() => ({ next: null as SwitchboardAnswer | null }));

vi.mock("../switchboard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../switchboard.js")>();
  return {
    ...actual,
    switchboardAnswerFor: vi.fn(async () => answer.next ?? { account: null, noAnswer: null }),
    forgetSwitchboardAccount: vi.fn(() => true),
  };
});

import {
  explainSwitchboardFallbackFailure,
  forgetSwitchboardAccountAfterSignInFailure,
  resolveAdapterAccountEnv,
  resolveAdapterAccountForRun,
} from "../active-account.js";
import { forgetSwitchboardAccount, switchboardAnswerFor } from "../switchboard.js";
import { resetAdapterAccountCaches, upsertAdapterAccount } from "../adapter-accounts.js";

const account = {
  accountId: "claude-account-2",
  label: "work-account",
  home: "C:\\Users\\me\\.claude-account-2",
  envVar: "CLAUDE_CONFIG_DIR",
  envValue: "C:\\Users\\me\\.claude-account-2",
  laneId: "lane-2",
  reason: "Subscription has capacity",
  token: null,
};

const machineSignIn: SwitchboardAnswer = {
  account: null,
  noAnswer: { reason: "Quota state is unknown or unreadable", usedInstead: "machine_sign_in" },
};

const replayed: SwitchboardAnswer = {
  account,
  noAnswer: {
    reason: "Quota state is unknown or unreadable",
    usedInstead: "recent_account",
    agedMs: 3 * 60 * 60_000,
  },
};

function useTempHome() {
  let homeDir = "";
  const priorHome = process.env.PAPERCLIP_HOME;
  const priorMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-account-fallback-"));
    process.env.PAPERCLIP_HOME = homeDir;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = Buffer.alloc(32, 13).toString("base64");
    resetAdapterAccountCaches();
    answer.next = null;
    vi.mocked(switchboardAnswerFor).mockClear();
    vi.mocked(forgetSwitchboardAccount).mockClear();
  });

  afterEach(() => {
    resetAdapterAccountCaches();
    if (priorHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = priorHome;
    if (priorMasterKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY = priorMasterKey;
    fs.rmSync(homeDir, { recursive: true, force: true });
  });
}

/**
 * What a run records when it lands on the machine's own sign-in because
 * Switchboard named nothing. On 2026-09-18 four runs did this and their
 * records said nothing about it: a missing `switchboardAccount`, which is also
 * what a machine without Switchboard looks like.
 */
describe("recording a fall back to the machine's own sign-in", () => {
  useTempHome();

  it("records the tool and switchboard's reason when the run reaches the machine's own sign-in", async () => {
    answer.next = machineSignIn;
    expect(await resolveAdapterAccountForRun("claude_local")).toEqual({
      resolved: null,
      switchboardFallback: { provider: "claude", reason: "Quota state is unknown or unreadable" },
      switchboardReplay: null,
      switchboardAccountInUse: null,
    });
    // The other callers still get the plain answer they always got.
    expect(await resolveAdapterAccountEnv("claude_local")).toBeNull();
  });

  /**
   * A reused account is a real account, so the run is on it and there is no
   * fall back to record. But its remembered reason could be "Subscription has
   * capacity" from hours ago, and with a day-long replay window the run log
   * would say the opposite of what happened, so the reason says it is a reuse,
   * and the run records the reuse so a sign-in failure on it can be explained.
   */
  it("records a reuse, not a fall back, when a recent account stands in", async () => {
    answer.next = replayed;
    const result = await resolveAdapterAccountForRun("claude_local");
    expect(result.switchboardFallback).toBeNull();
    expect(result.switchboardReplay).toEqual({
      provider: "claude",
      account: "work-account",
      reason: "Quota state is unknown or unreadable",
      agedMinutes: 180,
    });
    expect(result.switchboardAccountInUse).toEqual({ provider: "claude", accountId: "claude-account-2" });
    expect(result.resolved).toMatchObject({ source: "switchboard", label: "work-account", slot: null });
    expect(result.resolved?.reason).toBe(
      "Reused the account Switchboard named most recently, because it named none just now: Quota state is unknown or unreadable",
    );
    expect(result.resolved?.env.CLAUDE_CONFIG_DIR).toBe("C:\\Users\\me\\.claude-account-2");
  });

  it("keeps switchboard's own reason when it answered, and still notes the account in use", async () => {
    answer.next = { account, noAnswer: null };
    const result = await resolveAdapterAccountForRun("claude_local");
    expect(result.switchboardFallback).toBeNull();
    expect(result.switchboardReplay).toBeNull();
    expect(result.switchboardAccountInUse).toEqual({ provider: "claude", accountId: "claude-account-2" });
    expect(result.resolved?.reason).toBe("Subscription has capacity");
  });

  it("records nothing when switchboard was never asked", async () => {
    answer.next = { account: null, noAnswer: null };
    expect(await resolveAdapterAccountForRun("claude_local")).toEqual({
      resolved: null,
      switchboardFallback: null,
      switchboardReplay: null,
      switchboardAccountInUse: null,
    });
  });

  it("does not consult switchboard at all when paperclip has an account of its own", async () => {
    await upsertAdapterAccount({ adapterType: "claude_local", token: "token-one", label: "Main" });
    resetAdapterAccountCaches();
    answer.next = machineSignIn;
    const result = await resolveAdapterAccountForRun("claude_local");
    expect(result.resolved).toMatchObject({ source: "paperclip", label: "Main" });
    expect(result.switchboardFallback).toBeNull();
    expect(result.switchboardAccountInUse).toBeNull();
    expect(switchboardAnswerFor).not.toHaveBeenCalled();
  });

  it("records nothing for an adapter switchboard is never asked about", async () => {
    answer.next = machineSignIn;
    expect(await resolveAdapterAccountForRun("cursor")).toEqual({
      resolved: null,
      switchboardFallback: null,
      switchboardReplay: null,
      switchboardAccountInUse: null,
    });
  });
});

/**
 * A run whose own environment already says how the tool signs in did not use
 * the machine's inherited sign-in, so a failure on it must not be explained as
 * that. Codex and Gemini declare no account variable, so the heartbeat's
 * pinned-credential check never catches them, and the server-level API key
 * check never sees a key set on the agent or its project. The environment here
 * is the run's merged one, agent, project and issue overrides together.
 */
describe("a run that brings its own sign-in", () => {
  useTempHome();

  const cases: Array<[adapterType: string, variable: string]> = [
    ["claude_local", "ANTHROPIC_API_KEY"],
    ["claude_local", "ANTHROPIC_AUTH_TOKEN"],
    ["claude_local", "CLAUDE_CONFIG_DIR"],
    ["claude_local", "CLAUDE_CODE_OAUTH_TOKEN"],
    ["codex_local", "OPENAI_API_KEY"],
    ["codex_local", "CODEX_HOME"],
    ["gemini_local", "GEMINI_API_KEY"],
    ["gemini_local", "GOOGLE_API_KEY"],
    ["gemini_local", "GEMINI_CLI_HOME"],
  ];

  it.each(cases)("records no fall back for %s with %s in its env", async (adapterType, variable) => {
    answer.next = machineSignIn;
    const result = await resolveAdapterAccountForRun(adapterType, { runEnv: { [variable]: "set-by-the-agent" } });
    expect(result.resolved).toBeNull();
    expect(result.switchboardFallback).toBeNull();
    // Without it, the same run is recorded, which proves the variable is what
    // made the difference and not the adapter.
    const bare = await resolveAdapterAccountForRun(adapterType, { runEnv: {} });
    expect(bare.switchboardFallback?.reason).toBe("Quota state is unknown or unreadable");
  });

  /**
   * The Gemini case the review found: Switchboard has no Gemini lane, and a
   * Gemini agent with a bad key of its own fails. Its error must stay the
   * adapter's own, pointing at the key, not at Switchboard.
   */
  it("leaves a gemini agent's own key failure unexplained", async () => {
    answer.next = {
      account: null,
      noAnswer: { reason: "No configured lanes match the criteria.", usedInstead: "machine_sign_in" },
    };
    const { switchboardFallback } = await resolveAdapterAccountForRun("gemini_local", {
      runEnv: { GEMINI_API_KEY: "a-bad-key" },
    });
    const keyError = "Gemini run failed: API key not valid. Please pass a valid API key.";
    expect(
      explainSwitchboardFallbackFailure({ errorMessage: keyError, errorCode: "gemini_auth_required", switchboardFallback }),
    ).toBe(keyError);
  });

  it("does not count a blank value, which is how paperclip switches a variable off", async () => {
    answer.next = machineSignIn;
    const result = await resolveAdapterAccountForRun("claude_local", {
      runEnv: { ANTHROPIC_API_KEY: "  ", CLAUDE_CODE_OAUTH_TOKEN: "" },
    });
    expect(result.switchboardFallback).not.toBeNull();
  });

  it("does not count another tool's key", async () => {
    answer.next = machineSignIn;
    const result = await resolveAdapterAccountForRun("claude_local", { runEnv: { OPENAI_API_KEY: "sk-openai" } });
    expect(result.switchboardFallback).not.toBeNull();
  });

  /**
   * Only what is recorded changes. The run still gets the account Switchboard
   * named, exactly as before, but a failure on it may be the agent's key, so
   * it is neither explained as the reused account's nor allowed to make
   * Paperclip forget that account.
   */
  it("still hands over a reused account, but records no reuse and nothing to forget", async () => {
    answer.next = replayed;
    const result = await resolveAdapterAccountForRun("claude_local", { runEnv: { ANTHROPIC_API_KEY: "sk-ant-own" } });
    expect(result.resolved?.env.CLAUDE_CONFIG_DIR).toBe("C:\\Users\\me\\.claude-account-2");
    expect(result.switchboardReplay).toBeNull();
    expect(result.switchboardAccountInUse).toBeNull();
  });
});

/**
 * The run's error message when the machine's own sign-in is what failed.
 * Before, it said only "Failed to authenticate: OAuth session expired", which
 * reads as this agent's login breaking, when the story was that Switchboard
 * had no account to give.
 */
describe("explaining a sign-in failure after a fall back", () => {
  const incidentError =
    "Claude run failed: subtype=success: Failed to authenticate: OAuth session expired and could not be refreshed";
  const fallback = { provider: "claude", reason: "Quota state is unknown or unreadable" };

  it("puts the plain explanation first and keeps the original error after it", () => {
    expect(
      explainSwitchboardFallbackFailure({
        errorMessage: incidentError,
        errorCode: "claude_auth_required",
        switchboardFallback: fallback,
      }),
    ).toBe(
      "Switchboard had no Claude account available when this run started, so the run used this computer's own " +
        "Claude sign-in, which has expired or been signed out. Why Switchboard had no account: Quota state is " +
        `unknown or unreadable. Original error: ${incidentError}`,
    );
  });

  it("names the tool the run was for", () => {
    const text = explainSwitchboardFallbackFailure({
      errorMessage: "Codex run failed: not logged in",
      errorCode: "codex_auth_required",
      switchboardFallback: { provider: "codex", reason: "No lanes are configured." },
    });
    expect(text.startsWith("Switchboard had no Codex account available")).toBe(true);
    expect(text).toContain("this computer's own Codex sign-in");
    // Switchboard's own full stop is not doubled.
    expect(text).toContain("Why Switchboard had no account: No lanes are configured. Original error:");
  });

  it("leaves any other failure alone, fall back or not", () => {
    for (const errorCode of ["claude_plan_exhausted", "timeout", "adapter_failed", null]) {
      expect(
        explainSwitchboardFallbackFailure({ errorMessage: incidentError, errorCode, switchboardFallback: fallback }),
      ).toBe(incidentError);
    }
  });

  it("leaves a sign-in failure alone when the run did not fall back", () => {
    for (const switchboardFallback of [undefined, null, "yes", {}, { reason: "no provider" }]) {
      expect(
        explainSwitchboardFallbackFailure({
          errorMessage: incidentError,
          errorCode: "claude_auth_required",
          switchboardFallback,
        }),
      ).toBe(incidentError);
    }
  });

  it("still explains when the record has no reason", () => {
    const text = explainSwitchboardFallbackFailure({
      errorMessage: incidentError,
      errorCode: "claude_auth_required",
      switchboardFallback: { provider: "claude" },
    });
    expect(text).toBe(
      "Switchboard had no Claude account available when this run started, so the run used this computer's own " +
        `Claude sign-in, which has expired or been signed out. Original error: ${incidentError}`,
    );
  });
});

/**
 * The reviewer's scenario: Switchboard stops naming its Claude lanes because
 * their accounts are signed out, the run is put on the one it named last, and
 * that one cannot sign in either. Without this the error was the adapter's
 * bare words, exactly as on 2026-09-18.
 */
describe("explaining a sign-in failure on a reused account", () => {
  const incidentError =
    "Claude run failed: subtype=success: Failed to authenticate: OAuth session expired and could not be refreshed";
  const replay = {
    provider: "claude",
    account: "work-account",
    reason: "No lane is currently available.",
    agedMinutes: 180,
  };

  it("says which account was reused, how old the answer was, and that it will not be reused", () => {
    expect(
      explainSwitchboardFallbackFailure({
        errorMessage: incidentError,
        errorCode: "claude_auth_required",
        switchboardFallback: undefined,
        switchboardReplay: replay,
      }),
    ).toBe(
      'Switchboard had no Claude account available when this run started, so the run reused "work-account", ' +
        "the account Switchboard had named most recently (about 3 hours earlier), and that account could not sign in. " +
        "Paperclip will not reuse it again unless Switchboard names it. Why Switchboard had no account: No lane is " +
        `currently available. Original error: ${incidentError}`,
    );
  });

  it("puts a short age in minutes", () => {
    for (const [agedMinutes, words] of [
      [0, "(less than a minute earlier)"],
      [1, "(1 minute earlier)"],
      [45, "(45 minutes earlier)"],
    ] as const) {
      expect(
        explainSwitchboardFallbackFailure({
          errorMessage: incidentError,
          errorCode: "claude_auth_required",
          switchboardFallback: null,
          switchboardReplay: { ...replay, agedMinutes },
        }),
      ).toContain(words);
    }
  });

  it("still explains when the record lacks the account or the age", () => {
    const text = explainSwitchboardFallbackFailure({
      errorMessage: incidentError,
      errorCode: "claude_auth_required",
      switchboardFallback: null,
      switchboardReplay: { provider: "claude", reason: "No lane is currently available." },
    });
    expect(text).toContain("so the run reused the account, the account Switchboard had named most recently, and");
    expect(text.endsWith(`Original error: ${incidentError}`)).toBe(true);
  });

  it("leaves any other failure on a reused account alone", () => {
    for (const errorCode of ["claude_plan_exhausted", "timeout", "adapter_failed", null]) {
      expect(
        explainSwitchboardFallbackFailure({
          errorMessage: incidentError,
          errorCode,
          switchboardFallback: null,
          switchboardReplay: replay,
        }),
      ).toBe(incidentError);
    }
  });
});

/**
 * After a run on a Switchboard account fails to sign in, that account stops
 * being reused. Only a sign-in failure does it, and only for a run that was
 * really on the account.
 */
describe("forgetting an account after a sign-in failure", () => {
  beforeEach(() => {
    vi.mocked(forgetSwitchboardAccount).mockClear();
  });

  const inUse = { provider: "claude", accountId: "claude-account-2" };

  it("forgets the account the run was on when it failed to sign in", () => {
    expect(forgetSwitchboardAccountAfterSignInFailure("claude_auth_required", inUse)).toBe(true);
    expect(forgetSwitchboardAccount).toHaveBeenCalledWith("claude", "claude-account-2");
  });

  it("forgets nothing for any other failure", () => {
    for (const errorCode of ["claude_plan_exhausted", "timeout", "adapter_failed", null, undefined]) {
      expect(forgetSwitchboardAccountAfterSignInFailure(errorCode, inUse)).toBe(false);
    }
    expect(forgetSwitchboardAccount).not.toHaveBeenCalled();
  });

  it("forgets nothing when the run was not on a switchboard account", () => {
    expect(forgetSwitchboardAccountAfterSignInFailure("claude_auth_required", null)).toBe(false);
    expect(forgetSwitchboardAccount).not.toHaveBeenCalled();
  });
});
