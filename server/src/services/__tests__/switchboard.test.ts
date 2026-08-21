import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findSwitchboardCli,
  hasDeliberateApiKey,
  parseSwitchboardLane,
  readRegisteredAccounts,
  resetSwitchboardCache,
  switchboardAccountEnv,
  switchboardAccountsFile,
  switchboardOptedOut,
} from "../switchboard.js";

/**
 * These tests exist because every failure mode here has to end the same way:
 * Paperclip leaves the machine's existing sign-in alone. A bug that instead
 * points a run at a folder nobody is signed into looks exactly like the
 * twelve-hour outage this feature was written to prevent, so "returns null"
 * is the behaviour under test as much as "returns the account".
 */
describe("switchboard opt-out", () => {
  it("is off only for the exact word false", () => {
    expect(switchboardOptedOut({ SWITCHBOARD_ENABLED: "false" })).toBe(true);
    expect(switchboardOptedOut({ SWITCHBOARD_ENABLED: " FALSE " })).toBe(true);
    expect(switchboardOptedOut({ SWITCHBOARD_ENABLED: "true" })).toBe(false);
    expect(switchboardOptedOut({ SWITCHBOARD_ENABLED: "0" })).toBe(false);
    expect(switchboardOptedOut({})).toBe(false);
  });
});

describe("finding the switchboard cli", () => {
  const never = () => false;
  const always = () => true;

  it("finds nothing when the machine has opted out, even with a path given", () => {
    expect(
      findSwitchboardCli({
        env: { SWITCHBOARD_ENABLED: "false", SWITCHBOARD_BIN: "C:\\sb\\bin\\cli.js" },
        platform: "win32",
        exists: always,
      }),
    ).toBeNull();
  });

  it("runs an explicit .js path under this process's own node", () => {
    const found = findSwitchboardCli({
      env: { SWITCHBOARD_BIN: "C:\\dev\\switchboard\\bin\\cli.js" },
      platform: "win32",
      exists: never,
    });
    expect(found).toEqual({
      bin: process.execPath,
      prefixArgs: ["C:\\dev\\switchboard\\bin\\cli.js"],
      env: {},
      source: "SWITCHBOARD_BIN (script)",
    });
  });

  it("runs an explicit executable directly", () => {
    const found = findSwitchboardCli({
      env: { SWITCHBOARD_BIN: "C:\\sb\\Switchboard.exe" },
      platform: "win32",
      exists: never,
    });
    expect(found?.bin).toBe("C:\\sb\\Switchboard.exe");
    expect(found?.prefixArgs).toEqual([]);
  });

  /**
   * The asar case is the one that actually bit the Slack bridge: Electron reads
   * a path THROUGH the archive as if it were a directory, but ordinary Node
   * cannot, so testing for app.asar/bin/cli.js on disk decides Switchboard is
   * absent on a machine where it is installed and working.
   */
  it("looks inside the asar archive it can never stat directly", () => {
    const root = path.join("C:\\Users\\someone\\AppData\\Local", "Programs", "switchboard");
    const found = findSwitchboardCli({
      env: { LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local" },
      platform: "win32",
      exists: (p) =>
        p === path.join(root, "Switchboard.exe") || p === path.join(root, "resources", "app.asar"),
    });
    expect(found).toEqual({
      bin: path.join(root, "Switchboard.exe"),
      prefixArgs: [path.join(root, "resources", "app.asar", "bin", "cli.js")],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      source: "installed app",
    });
  });

  it("falls back to an unpacked build when there is no archive", () => {
    const root = path.join("C:\\Local", "Programs", "switchboard");
    const found = findSwitchboardCli({
      env: { LOCALAPPDATA: "C:\\Local" },
      platform: "win32",
      exists: (p) =>
        p === path.join(root, "Switchboard.exe") ||
        p === path.join(root, "resources", "app", "bin", "cli.js"),
    });
    expect(found?.prefixArgs).toEqual([path.join(root, "resources", "app", "bin", "cli.js")]);
  });

  it("finds nothing when the executable is there but its code is not", () => {
    const root = path.join("C:\\Local", "Programs", "switchboard");
    expect(
      findSwitchboardCli({
        env: { LOCALAPPDATA: "C:\\Local" },
        platform: "win32",
        exists: (p) => p === path.join(root, "Switchboard.exe"),
      }),
    ).toBeNull();
  });

  it("finds nothing on a machine with no switchboard at all", () => {
    expect(
      findSwitchboardCli({ env: { LOCALAPPDATA: "C:\\Local" }, platform: "win32", exists: never }),
    ).toBeNull();
  });
});

describe("reading switchboard's answer", () => {
  it("reads the lane out of a reply that also carries other lines", () => {
    const stdout = [
      "Checking lanes...",
      JSON.stringify({
        laneId: "lane-claude-2",
        harness: "claude",
        provider: "claude",
        accountId: "claude-account-2",
        billing: "subscription",
        reason: "Subscription has capacity",
        available: true,
      }),
    ].join("\n");
    expect(parseSwitchboardLane(stdout)).toEqual({
      laneId: "lane-claude-2",
      provider: "claude",
      accountId: "claude-account-2",
      reason: "Subscription has capacity",
    });
  });

  /**
   * "No lane available" is a normal answer, not an error, and it arrives on a
   * non-zero exit. Reading it as an account would send the run to nowhere.
   */
  it("treats an unavailable answer as no answer", () => {
    expect(
      parseSwitchboardLane(JSON.stringify({ available: false, reason: "No configured lanes match the criteria." })),
    ).toBeNull();
  });

  it("ignores an answer missing the parts it needs", () => {
    expect(parseSwitchboardLane(JSON.stringify({ available: true, laneId: "x" }))).toBeNull();
    expect(parseSwitchboardLane(JSON.stringify({ available: true, provider: "claude" }))).toBeNull();
  });

  it("survives output that is not JSON at all", () => {
    expect(parseSwitchboardLane("")).toBeNull();
    expect(parseSwitchboardLane("Selected lane: lane-claude-2")).toBeNull();
    expect(parseSwitchboardLane("{not json")).toBeNull();
  });
});

describe("reading switchboard's registered accounts", () => {
  let dir: string;
  const priorAppData = process.env.APPDATA;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-switchboard-"));
    process.env.APPDATA = dir;
    resetSwitchboardCache();
  });

  afterEach(() => {
    if (priorAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = priorAppData;
    resetSwitchboardCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeAccounts(body: string): void {
    const file = switchboardAccountsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, "utf8");
  }

  it("maps each account id to the folder it lives in", () => {
    writeAccounts(
      JSON.stringify({
        accounts: [
          { id: "claude-default", provider: "claude", label: "Default", home: "C:\\Users\\me\\.claude" },
          { id: "claude-two", provider: "claude", label: "Second", home: "C:\\Users\\me\\.claude-two" },
        ],
      }),
    );
    const accounts = readRegisteredAccounts();
    expect(accounts.get("claude-two")).toEqual({
      id: "claude-two",
      provider: "claude",
      label: "Second",
      home: "C:\\Users\\me\\.claude-two",
    });
  });

  it("names an account after its id when it has no label", () => {
    writeAccounts(JSON.stringify({ accounts: [{ id: "codex-default", provider: "codex", home: "C:\\c" }] }));
    expect(readRegisteredAccounts().get("codex-default")?.label).toBe("codex-default");
  });

  it("drops entries missing anything it needs rather than inventing it", () => {
    writeAccounts(
      JSON.stringify({
        accounts: [
          { id: "no-home", provider: "claude" },
          { provider: "claude", home: "C:\\x" },
          { id: "good", provider: "claude", home: "C:\\y" },
        ],
      }),
    );
    const accounts = readRegisteredAccounts();
    expect([...accounts.keys()]).toEqual(["good"]);
  });

  it("gives an empty answer when there is no file, rather than throwing", () => {
    expect(readRegisteredAccounts().size).toBe(0);
  });

  it("gives an empty answer for a file it cannot parse", () => {
    writeAccounts("{ this is not json");
    expect(readRegisteredAccounts().size).toBe(0);
  });

  it("gives an empty answer for a shape it does not recognise", () => {
    writeAccounts(JSON.stringify({ version: 2, entries: [] }));
    expect(readRegisteredAccounts().size).toBe(0);
  });
});

describe("the environment that puts a run on a chosen account", () => {
  const claudeAccount = {
    accountId: "claude-two",
    label: "Second",
    home: "C:\\Users\\me\\.claude-two",
    envVar: "CLAUDE_CONFIG_DIR",
    envValue: "C:\\Users\\me\\.claude-two",
    laneId: "lane-2",
    reason: "Subscription has capacity",
  };

  /**
   * The empty strings are the point of this test. Paperclip persists a
   * long-lived token to the Windows user environment when someone uses the
   * Adapters sign-in button, and that token outranks the config folder. Without
   * clearing it the chosen account is silently ignored and the run signs in as
   * whoever the stale token belongs to.
   */
  it("clears the tokens that would outrank the folder", () => {
    const env = switchboardAccountEnv(claudeAccount);
    expect(env.CLAUDE_CONFIG_DIR).toBe("C:\\Users\\me\\.claude-two");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("");
    expect(env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN).toBe("");
  });

  /**
   * An API key is a different, deliberate way to pay for the work. Clearing one
   * would quietly move an operator off it, so those variables are left alone
   * and the decision not to re-route is made earlier instead.
   */
  it("leaves the api-key variables alone", () => {
    const env = switchboardAccountEnv(claudeAccount);
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(env).not.toHaveProperty("ANTHROPIC_BASE_URL");
  });

  it("sets only the folder variable for a tool with no competing tokens", () => {
    expect(
      switchboardAccountEnv({
        accountId: "codex-default",
        label: "Default",
        home: "C:\\Users\\me\\.codex",
        envVar: "CODEX_HOME",
        envValue: "C:\\Users\\me\\.codex",
        laneId: "lane-codex",
        reason: "Subscription has capacity",
      }),
    ).toEqual({ CODEX_HOME: "C:\\Users\\me\\.codex" });
  });
});

describe("spotting a deliberate api key", () => {
  it("sees a key that is actually set", () => {
    expect(hasDeliberateApiKey({ ANTHROPIC_API_KEY: "sk-ant-x" })).toBe(true);
    expect(hasDeliberateApiKey({ ANTHROPIC_AUTH_TOKEN: "tok" })).toBe(true);
  });

  it("does not count an empty one, which is how a variable gets switched off", () => {
    expect(hasDeliberateApiKey({ ANTHROPIC_API_KEY: "" })).toBe(false);
    expect(hasDeliberateApiKey({ ANTHROPIC_API_KEY: "   " })).toBe(false);
    expect(hasDeliberateApiKey({})).toBe(false);
  });
});
