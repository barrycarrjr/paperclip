import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The logger is stubbed so the warnings can be counted. switchboard.ts takes a
 * child logger when it is imported, so `child` hands back the same spies.
 */
const log = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../middleware/logger.js", () => ({
  logger: { ...log, child: () => log },
}));

import {
  describeSwitchboardRefusal,
  envCarriesOwnSignIn,
  forgetSwitchboardAccount,
  resetSwitchboardCache,
  switchboardAccountEnv,
  switchboardAnswerFor,
  type SwitchboardNoAccount,
} from "../switchboard.js";

/**
 * On 2026-09-18 Switchboard named no account for about three hours, an agent
 * ran four times on the machine's own expired sign-in, and nothing at info or
 * warn level said so. These cover the fix: say it once when it starts, say
 * which way the runs went, and do not say it again on every run.
 */
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
const quotaUnknown: SwitchboardNoAccount = {
  available: false,
  reason: "Quota state is unknown or unreadable",
};
const START = 1_000_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function warnings(): Array<{ fields: Record<string, unknown>; message: string }> {
  return log.warn.mock.calls.map(([fields, message]) => ({
    fields: fields as Record<string, unknown>,
    message: String(message),
  }));
}

describe("saying so when switchboard names no account", () => {
  const priorApiKey = process.env.ANTHROPIC_API_KEY;
  const priorAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    resetSwitchboardCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (priorApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = priorApiKey;
    if (priorAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = priorAuthToken;
    resetSwitchboardCache();
  });

  it("warns once when a recent account stands in, with switchboard's reason", async () => {
    await switchboardAnswerFor("claude", { now: START, ask: async () => account });
    expect(log.warn).not.toHaveBeenCalled();

    // Past the one-minute answer cache, so each of these genuinely asks.
    const answer = await switchboardAnswerFor("claude", { now: START + 5 * MINUTE, ask: async () => quotaUnknown });
    expect(answer).toEqual({
      account,
      noAnswer: { reason: "Quota state is unknown or unreadable", usedInstead: "recent_account", agedMs: 5 * MINUTE },
    });
    await switchboardAnswerFor("claude", { now: START + 10 * MINUTE, ask: async () => quotaUnknown });
    await switchboardAnswerFor("claude", { now: START + 10 * MINUTE + 1_000, ask: async () => quotaUnknown });
    await switchboardAnswerFor("claude", { now: START + 3 * 60 * MINUTE, ask: async () => quotaUnknown });

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]!.fields).toEqual({
      provider: "claude",
      reason: "Quota state is unknown or unreadable",
      usedInstead: "recent_account",
      account: "work-account",
      agedMinutes: 5,
    });
    expect(warnings()[0]!.message).toContain("reuse the account it named most recently");
  });

  it("warns again, once, when the stand-in lapses and runs reach the machine's own sign-in", async () => {
    await switchboardAnswerFor("claude", { now: START, ask: async () => account });
    await switchboardAnswerFor("claude", { now: START + 5 * MINUTE, ask: async () => quotaUnknown });

    const lapsed = await switchboardAnswerFor("claude", { now: START + DAY + MINUTE, ask: async () => quotaUnknown });
    expect(lapsed).toEqual({
      account: null,
      noAnswer: { reason: "Quota state is unknown or unreadable", usedInstead: "machine_sign_in" },
    });
    await switchboardAnswerFor("claude", { now: START + DAY + 5 * MINUTE, ask: async () => quotaUnknown });
    await switchboardAnswerFor("claude", { now: START + DAY + 9 * MINUTE, ask: async () => quotaUnknown });

    expect(warnings().map((w) => w.fields.usedInstead)).toEqual(["recent_account", "machine_sign_in"]);
    expect(warnings()[1]!.fields).toEqual({
      provider: "claude",
      reason: "Quota state is unknown or unreadable",
      usedInstead: "machine_sign_in",
    });
    expect(warnings()[1]!.message).toContain("this machine's own sign-in");
  });

  it("warns about the machine's own sign-in straight away when nothing was ever named", async () => {
    const answer = await switchboardAnswerFor("claude", { now: START, ask: async () => quotaUnknown });
    expect(answer.account).toBeNull();
    expect(answer.noAnswer).toEqual({
      reason: "Quota state is unknown or unreadable",
      usedInstead: "machine_sign_in",
    });
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]!.fields.usedInstead).toBe("machine_sign_in");
  });

  /**
   * The state is which way runs went, not Switchboard's exact wording, so a
   * reason that changes while runs keep going the same way does not write a
   * fresh warning each time. Each run still carries its own reason.
   */
  it("does not warn again when only the wording of the reason changes", async () => {
    await switchboardAnswerFor("claude", { now: START, ask: async () => quotaUnknown });
    const later = await switchboardAnswerFor("claude", {
      now: START + 5 * MINUTE,
      ask: async () => ({ available: false, reason: "No lane is currently available." }),
    });
    expect(later.noAnswer?.reason).toBe("No lane is currently available.");
    expect(warnings()).toHaveLength(1);
  });

  it("says once, at info, when switchboard names an account again, and warns afresh if it stops again", async () => {
    await switchboardAnswerFor("claude", { now: START, ask: async () => quotaUnknown });
    await switchboardAnswerFor("claude", { now: START + 5 * MINUTE, ask: async () => account });
    await switchboardAnswerFor("claude", { now: START + 10 * MINUTE, ask: async () => account });
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(String(log.info.mock.calls[0]![1])).toContain("naming an account again");

    await switchboardAnswerFor("claude", { now: START + 15 * MINUTE, ask: async () => quotaUnknown });
    expect(warnings().map((w) => w.fields.usedInstead)).toEqual(["machine_sign_in", "recent_account"]);
  });

  it("gives a cached no the same answer and the same silence", async () => {
    await switchboardAnswerFor("claude", { now: START, ask: async () => quotaUnknown });
    let askedAgain = false;
    const cached = await switchboardAnswerFor("claude", {
      now: START + 30_000,
      ask: async () => {
        askedAgain = true;
        return account;
      },
    });
    expect(askedAgain).toBe(false);
    expect(cached.noAnswer?.usedInstead).toBe("machine_sign_in");
    expect(warnings()).toHaveLength(1);
  });

  /**
   * No Switchboard, or one deliberately bypassed, is how every install ran
   * before any of this. None of it is a fault, so none of it is reported.
   */
  it("says nothing and records nothing when there is no switchboard to ask", async () => {
    const answer = await switchboardAnswerFor("claude", { now: START, ask: async () => null });
    expect(answer).toEqual({ account: null, noAnswer: null });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("says nothing and does not ask when an api key is in use", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-deliberate";
    let asked = false;
    const answer = await switchboardAnswerFor("claude", {
      now: START,
      ask: async () => {
        asked = true;
        return quotaUnknown;
      },
    });
    expect(answer).toEqual({ account: null, noAnswer: null });
    expect(asked).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("keeps each tool's state apart", async () => {
    await switchboardAnswerFor("claude", { now: START, ask: async () => quotaUnknown });
    await switchboardAnswerFor("codex", { now: START, ask: async () => quotaUnknown });
    expect(warnings().map((w) => w.fields.provider)).toEqual(["claude", "codex"]);
  });
});

/**
 * The way out of the day-long reuse. If Switchboard fell silent because the
 * account it named last was signed out, reusing that account for a day would
 * send every run to a dead folder, and strip a working host-wide token from
 * each one on the way (a reuse runs in folder mode, which blanks the token
 * variables). The first run on it that fails to sign in ends the reuse.
 */
describe("forgetting an account a run could not sign in with", () => {
  const priorApiKey = process.env.ANTHROPIC_API_KEY;
  const priorAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const otherAccount = { ...account, accountId: "claude-account-3", label: "third", laneId: "lane-3" };

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    resetSwitchboardCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (priorApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = priorApiKey;
    if (priorAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = priorAuthToken;
    resetSwitchboardCache();
  });

  it("a reuse blanks the host-wide token, which is why it needs a way out", async () => {
    await switchboardAnswerFor("claude", { now: START, ask: async () => account });
    const reused = await switchboardAnswerFor("claude", { now: START + 5 * MINUTE, ask: async () => quotaUnknown });
    expect(switchboardAccountEnv(reused.account!).CLAUDE_CODE_OAUTH_TOKEN).toBe("");
  });

  it("sends the next run to the machine's own sign-in, and says so", async () => {
    await switchboardAnswerFor("claude", { now: START, ask: async () => account });
    await switchboardAnswerFor("claude", { now: START + 5 * MINUTE, ask: async () => quotaUnknown });

    expect(forgetSwitchboardAccount("claude", "claude-account-2")).toBe(true);

    // Still inside the one-minute cache: the cached "no" now has nothing to
    // stand in for it, so the run reaches the machine's own sign-in.
    const next = await switchboardAnswerFor("claude", { now: START + 5 * MINUTE + 1_000, ask: async () => quotaUnknown });
    expect(next).toEqual({
      account: null,
      noAnswer: { reason: "Quota state is unknown or unreadable", usedInstead: "machine_sign_in" },
    });
    expect(warnings().map((w) => w.message)).toEqual([
      expect.stringContaining("reuse the account it named most recently"),
      expect.stringContaining("could not sign in"),
      expect.stringContaining("this machine's own sign-in"),
    ]);
    expect(warnings()[1]!.fields).toEqual({ provider: "claude", account: "work-account" });
  });

  it("writes one line for a burst of failures on the same account", async () => {
    await switchboardAnswerFor("claude", { now: START, ask: async () => account });
    expect(forgetSwitchboardAccount("claude", "claude-account-2")).toBe(true);
    expect(forgetSwitchboardAccount("claude", "claude-account-2")).toBe(false);
    expect(forgetSwitchboardAccount("claude", "claude-account-2")).toBe(false);
    expect(warnings()).toHaveLength(1);
  });

  /**
   * Switchboard may name a different account between a run starting and that
   * run failing. The newer account has done nothing wrong, so it stays.
   */
  it("leaves alone an account switchboard named since", async () => {
    await switchboardAnswerFor("claude", { now: START, ask: async () => account });
    await switchboardAnswerFor("claude", { now: START + 5 * MINUTE, ask: async () => otherAccount });

    expect(forgetSwitchboardAccount("claude", "claude-account-2")).toBe(false);
    const reused = await switchboardAnswerFor("claude", { now: START + 10 * MINUTE, ask: async () => quotaUnknown });
    expect(reused.account?.accountId).toBe("claude-account-3");
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0]![1])).toContain("reuse the account it named most recently");
  });

  /**
   * A fresh answer is cached for a minute. Dropping it means the next run asks
   * Switchboard again rather than being handed the failed folder, and whatever
   * Switchboard then says wins, as a fresh answer always does.
   */
  it("drops a cached answer naming the account, so the next run asks again", async () => {
    await switchboardAnswerFor("claude", { now: START, ask: async () => account });
    expect(forgetSwitchboardAccount("claude", "claude-account-2")).toBe(true);

    let asked = false;
    const next = await switchboardAnswerFor("claude", {
      now: START + 10_000,
      ask: async () => {
        asked = true;
        return account;
      },
    });
    expect(asked).toBe(true);
    expect(next.account?.accountId).toBe("claude-account-2");
  });

  it("keeps each tool apart", async () => {
    await switchboardAnswerFor("claude", { now: START, ask: async () => account });
    expect(forgetSwitchboardAccount("codex", "claude-account-2")).toBe(false);
    const reused = await switchboardAnswerFor("claude", { now: START + 5 * MINUTE, ask: async () => quotaUnknown });
    expect(reused.account?.accountId).toBe("claude-account-2");
  });
});

describe("seeing a run's own sign-in in its environment", () => {
  it("counts each tool's own keys, tokens and folder", () => {
    for (const [provider, name] of [
      ["claude", "ANTHROPIC_API_KEY"],
      ["claude", "ANTHROPIC_AUTH_TOKEN"],
      ["claude", "CLAUDE_CODE_OAUTH_TOKEN"],
      ["claude", "CLAUDE_CONFIG_DIR"],
      ["codex", "OPENAI_API_KEY"],
      ["codex", "CODEX_HOME"],
      ["gemini", "GEMINI_API_KEY"],
      ["gemini", "GOOGLE_API_KEY"],
      ["gemini", "GEMINI_CLI_HOME"],
      ["qwen", "QWEN_HOME"],
    ] as const) {
      expect(envCarriesOwnSignIn(provider, { [name]: "set" }), `${provider} ${name}`).toBe(true);
    }
  });

  it("ignores blanks, other tools' variables, non-strings and unknown tools", () => {
    expect(envCarriesOwnSignIn("claude", {})).toBe(false);
    expect(envCarriesOwnSignIn("claude", { ANTHROPIC_API_KEY: "   ", CLAUDE_CODE_OAUTH_TOKEN: "" })).toBe(false);
    expect(envCarriesOwnSignIn("claude", { OPENAI_API_KEY: "sk", GEMINI_API_KEY: "g" })).toBe(false);
    expect(envCarriesOwnSignIn("gemini", { ANTHROPIC_API_KEY: "sk-ant" })).toBe(false);
    expect(envCarriesOwnSignIn("claude", { ANTHROPIC_API_KEY: { type: "secret_ref" } })).toBe(false);
    expect(envCarriesOwnSignIn("not-a-tool", { ANTHROPIC_API_KEY: "sk-ant" })).toBe(false);
  });
});

describe("putting switchboard's refusal into words", () => {
  it("repeats switchboard's own reason for an unavailable answer", () => {
    expect(
      describeSwitchboardRefusal(
        ["Checking lanes...", JSON.stringify({ available: false, reason: "Quota state is unknown or unreadable" })].join(
          "\n",
        ),
      ),
    ).toBe("Quota state is unknown or unreadable");
  });

  it("says so when an unavailable answer gives no reason", () => {
    expect(describeSwitchboardRefusal(JSON.stringify({ available: false }))).toBe(
      "Switchboard said no account is available, without saying why",
    );
  });

  it("says so when switchboard printed nothing", () => {
    expect(describeSwitchboardRefusal("")).toBe("Switchboard printed nothing");
    expect(describeSwitchboardRefusal("  \r\n  ")).toBe("Switchboard printed nothing");
  });

  it("says so when the answer is not JSON, without repeating it", () => {
    expect(describeSwitchboardRefusal("Selected lane: lane-claude-2")).toBe(
      "Switchboard's answer was not the JSON Paperclip asked for",
    );
  });

  /**
   * A reply cut off mid-line by the timeout can hold a lane token (the request
   * carries --with-token). Only the parsed reason is ever repeated, so a
   * broken line cannot carry the secret into a log line or a run record.
   */
  it("never repeats a broken line that may carry a lane token", () => {
    const secret = "sk-ant-oat01-FAKE-must-not-surface";
    const text = describeSwitchboardRefusal(`{"available":true,"laneId":"lane-1","token":"${secret}`);
    expect(text).not.toContain(secret);
    expect(text).toBe("Switchboard's answer was not the JSON Paperclip asked for");
  });

  it("says so when a yes names no lane or account", () => {
    expect(describeSwitchboardRefusal(JSON.stringify({ available: true, laneId: "x" }))).toBe(
      "Switchboard answered without naming a lane and an account",
    );
  });

  it("keeps a long reason to one short line", () => {
    const text = describeSwitchboardRefusal(JSON.stringify({ available: false, reason: `line one\n${"x".repeat(500)}` }));
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text).not.toContain("\n");
    expect(text.startsWith("line one x")).toBe(true);
  });
});

/**
 * The same stand-in-CLI approach as switchboard.test.ts, for the two ways a
 * real Switchboard says no: a JSON "no" with its reason, and a crash with
 * nothing printed at all. Proves the reason survives the whole trip from a
 * real process to the answer the run path reads.
 */
describe("hearing no from a stand-in switchboard for real", () => {
  let dir: string;
  const prior = {
    SWITCHBOARD_BIN: process.env.SWITCHBOARD_BIN,
    APPDATA: process.env.APPDATA,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    SWITCHBOARD_ENABLED: process.env.SWITCHBOARD_ENABLED,
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-switchboard-no-"));
    process.env.APPDATA = dir;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.SWITCHBOARD_ENABLED;
    resetSwitchboardCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetSwitchboardCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function standIn(lines: string[]): void {
    const script = path.join(dir, "fake-switchboard-cli.js");
    fs.writeFileSync(script, lines.join("\n"), "utf8");
    process.env.SWITCHBOARD_BIN = script;
  }

  it("carries switchboard's own reason from an unavailable answer on a non-zero exit", async () => {
    standIn([
      "process.stdout.write(JSON.stringify({",
      "  available: false,",
      "  reason: 'Quota state is unknown or unreadable',",
      "}) + '\\n');",
      "process.exitCode = 1;",
    ]);
    const answer = await switchboardAnswerFor("claude", {});
    expect(answer).toEqual({
      account: null,
      noAnswer: { reason: "Quota state is unknown or unreadable", usedInstead: "machine_sign_in" },
    });
    expect(warnings()).toHaveLength(1);
  });

  it("names the exit when switchboard fails without printing anything", async () => {
    standIn(["process.exitCode = 3;"]);
    const answer = await switchboardAnswerFor("claude", {});
    expect(answer.noAnswer).toEqual({
      reason: "Switchboard exited with code 3 and printed nothing",
      usedInstead: "machine_sign_in",
    });
  });
});
