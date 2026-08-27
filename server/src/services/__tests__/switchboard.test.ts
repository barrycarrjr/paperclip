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
  switchboardAccountFor,
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
  /**
   * The two names in one reply are the whole point of this shape. `harness` is
   * the tool Paperclip cares about; `provider` is the vendor, which is what
   * `dry-run --provider` filters on. Confusing them is what made an earlier
   * version of this ask for `--provider claude` and be told, truthfully and
   * uselessly, that no lane matched.
   */
  it("reads both the tool and the vendor out of a reply that carries other lines", () => {
    const stdout = [
      "Checking lanes...",
      JSON.stringify({
        laneId: "lane-1787257318784",
        harness: "claude",
        provider: "anthropic",
        accountId: "claude-account-2",
        billing: "subscription",
        reason: "Subscription has capacity",
        available: true,
      }),
    ].join("\n");
    expect(parseSwitchboardLane(stdout)).toEqual({
      laneId: "lane-1787257318784",
      harness: "claude",
      provider: "anthropic",
      accountId: "claude-account-2",
      reason: "Subscription has capacity",
      token: null,
    });
  });

  /**
   * The token check is on content, not presence. A reply serialised with
   * `token: null` would pass a presence check and put the literal text "null"
   * into the child environment, signing the run in as nobody, which is the
   * exact outage this module exists to prevent. So everything that is not a
   * real string with visible content reads as "no token", which is folder
   * mode, which is today's working behaviour.
   */
  it("carries a token only when it is a real non-empty string", () => {
    const base = {
      laneId: "lane-1",
      harness: "claude",
      provider: "anthropic",
      accountId: "claude-account-2",
      available: true,
    };
    expect(parseSwitchboardLane(JSON.stringify({ ...base, token: "sk-ant-oat01-lane" }))?.token).toBe(
      "sk-ant-oat01-lane",
    );
    expect(parseSwitchboardLane(JSON.stringify(base))?.token).toBeNull();
    expect(parseSwitchboardLane(JSON.stringify({ ...base, token: null }))?.token).toBeNull();
    expect(parseSwitchboardLane(JSON.stringify({ ...base, token: "" }))?.token).toBeNull();
    expect(parseSwitchboardLane(JSON.stringify({ ...base, token: "   " }))?.token).toBeNull();
    expect(parseSwitchboardLane(JSON.stringify({ ...base, token: 42 }))?.token).toBeNull();
  });

  it("leaves the tool empty for an older switchboard that does not report one", () => {
    expect(
      parseSwitchboardLane(
        JSON.stringify({
          laneId: "lane-1",
          provider: "anthropic",
          accountId: "claude-account-2",
          available: true,
        }),
      ),
    ).toMatchObject({ harness: "", provider: "anthropic" });
  });

  /**
   * "No lane available" is a normal answer, not an error, and it arrives on a
   * non-zero exit. Reading it as an account would send the run to nowhere.
   *
   * Every flavour of it is listed because Switchboard distinguishes them and
   * Paperclip deliberately does not: all of them mean "sign in the way you
   * always did". Reading the prose to tell them apart would make this brittle
   * to wording that has already changed once, and there is nothing Paperclip
   * would do differently anyway.
   */
  it.each([
    "No lanes are configured.",
    "No configured lanes match the criteria.",
    "No lane is currently available.",
    "some future wording nobody has written yet",
  ])("treats an unavailable answer as no answer, whatever it says (%s)", (reason) => {
    expect(parseSwitchboardLane(JSON.stringify({ available: false, reason }))).toBeNull();
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
    token: null,
  };
  const codexAccount = {
    accountId: "codex-default",
    label: "Default",
    home: "C:\\Users\\me\\.codex",
    envVar: "CODEX_HOME",
    envValue: "C:\\Users\\me\\.codex",
    laneId: "lane-codex",
    reason: "Subscription has capacity",
    token: null,
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
    expect(switchboardAccountEnv(codexAccount)).toEqual({ CODEX_HOME: "C:\\Users\\me\\.codex" });
  });

  /**
   * The fallback guarantee, written out literally. Every path that ends with
   * "no token" (Switchboard too old, token dead, feature never set up) has to
   * produce this exact object, because this object is the behaviour that was
   * already working before lane tokens existed. A drift here would not fail
   * loudly; it would quietly change how every tokenless run signs in.
   */
  it("builds byte-for-byte today's environment when the lane has no token", () => {
    expect(switchboardAccountEnv(claudeAccount)).toEqual({
      CLAUDE_CONFIG_DIR: "C:\\Users\\me\\.claude-two",
      CLAUDE_CODE_OAUTH_TOKEN: "",
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "",
      CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "",
      CCR_OAUTH_TOKEN_FILE: "",
    });
  });

  /**
   * With a token the run authenticates on the token alone, so the folder's
   * OAuth login is never opened, but everything else stays exactly as it was:
   * the folder variable still points config and trust at the lane folder, and
   * the other credential variables are still forced off so nothing inherited
   * from the machine can outrank the choice.
   */
  it("puts a lane token in the child environment, still blanking everything else", () => {
    expect(switchboardAccountEnv({ ...claudeAccount, token: "sk-ant-oat01-lane" })).toEqual({
      CLAUDE_CONFIG_DIR: "C:\\Users\\me\\.claude-two",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-lane",
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "",
      CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "",
      CCR_OAUTH_TOKEN_FILE: "",
    });
  });

  it("ignores a stray token for a tool with no claude credential variables", () => {
    expect(switchboardAccountEnv({ ...codexAccount, token: "stray-token" })).toEqual({
      CODEX_HOME: "C:\\Users\\me\\.codex",
    });
  });
});

/**
 * Switchboard judges a lane's health from a live quota fetch and reports the
 * lane unusable when that fetch merely fails, so the same signed-in account can
 * read "has capacity" and "unknown or unreadable" minutes apart. When that hits
 * every lane of a tool, the answer is "nothing available", which looks exactly
 * like being genuinely out of allowance.
 */
describe("riding out a momentary no-answer", () => {
  const account = {
    accountId: "claude-account-2",
    label: "Secondary",
    home: "C:\\Users\\me\\.claude-account-2",
    envVar: "CLAUDE_CONFIG_DIR",
    envValue: "C:\\Users\\me\\.claude-account-2",
    laneId: "lane-2",
    reason: "Subscription has capacity",
    token: null,
  };
  const START = 1_000_000;
  const priorApiKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    resetSwitchboardCache();
  });

  afterEach(() => {
    if (priorApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = priorApiKey;
    resetSwitchboardCache();
  });

  it("reuses the account it was given when the next answer is nothing", async () => {
    expect(await switchboardAccountFor("claude", { now: START, ask: async () => account })).toEqual(account);
    // Past the ordinary answer cache, so this genuinely asks again.
    const later = START + 5 * 60_000;
    expect(await switchboardAccountFor("claude", { now: later, ask: async () => null })).toEqual(account);
  });

  /**
   * A replayed answer can be up to thirty minutes old, and a token that old
   * may have been rotated or revoked in between. Replaying it would hard-fail
   * the very run the replay was meant to save, while replaying just the folder
   * pointer falls back to the file sign-in, which is the behaviour that was
   * already working before tokens existed. The fresh answer keeps its token;
   * only the remembered copy is stripped.
   */
  it("replays a remembered answer with its token stripped", async () => {
    const withToken = { ...account, token: "sk-ant-oat01-stale" };
    expect(
      await switchboardAccountFor("claude", { now: START, ask: async () => withToken }),
    ).toEqual(withToken);
    // Past the ordinary answer cache, so this genuinely asks again and falls
    // back to the remembered answer.
    const later = START + 5 * 60_000;
    const replayed = await switchboardAccountFor("claude", { now: later, ask: async () => null });
    expect(replayed).toEqual({ ...account, token: null });
    // And the environment built from the replay blanks the variable rather
    // than carrying the stale secret.
    expect(switchboardAccountEnv(replayed!).CLAUDE_CODE_OAUTH_TOKEN).toBe("");
  });

  it("stops reusing it once it is properly stale", async () => {
    await switchboardAccountFor("claude", { now: START, ask: async () => account });
    const muchLater = START + 31 * 60_000;
    expect(await switchboardAccountFor("claude", { now: muchLater, ask: async () => null })).toBeNull();
  });

  it("gives a cached nothing the same courtesy instead of shadowing the remembered answer", async () => {
    expect(await switchboardAccountFor("claude", { now: START, ask: async () => account })).toEqual(account);
    // Past the ordinary answer cache, so this genuinely asks again, gets nothing,
    // caches that nothing, and falls back to the remembered answer.
    const later = START + 5 * 60_000;
    expect(await switchboardAccountFor("claude", { now: later, ask: async () => null })).toEqual(account);
    // Half a minute on, the cached nothing is consulted first. It must defer to
    // the remembered answer the same way the fresh nothing did, without asking
    // again; a cached null used to shadow the fallback for its whole minute.
    let askedAgain = false;
    const withinCache = later + 30_000;
    const answer = await switchboardAccountFor("claude", {
      now: withinCache,
      ask: async () => { askedAgain = true; return null; },
    });
    expect(answer).toEqual(account);
    expect(askedAgain).toBe(false);
  });

  it("prefers a fresh answer over the remembered one", async () => {
    await switchboardAccountFor("claude", { now: START, ask: async () => account });
    const other = { ...account, accountId: "claude-default", label: "Main Account", laneId: "lane-1" };
    const later = START + 5 * 60_000;
    expect(await switchboardAccountFor("claude", { now: later, ask: async () => other })).toEqual(other);
  });

  it("has nothing to reuse when it was never given an account", async () => {
    expect(await switchboardAccountFor("claude", { now: START, ask: async () => null })).toBeNull();
  });

  it("answers from the cache rather than asking twice in a burst", async () => {
    let asked = 0;
    const ask = async () => {
      asked += 1;
      return account;
    };
    await switchboardAccountFor("claude", { now: START, ask });
    await switchboardAccountFor("claude", { now: START + 1_000, ask });
    expect(asked).toBe(1);
  });

  it("does not consult switchboard at all when an api key is set", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-deliberate";
    let asked = 0;
    const result = await switchboardAccountFor("claude", {
      now: START,
      ask: async () => {
        asked += 1;
        return account;
      },
    });
    expect(result).toBeNull();
    expect(asked).toBe(0);
  });

  it("knows nothing about a tool switchboard cannot move", async () => {
    expect(await switchboardAccountFor("aider", { now: START, ask: async () => account })).toBeNull();
  });
});

/**
 * The one place the real argv is visible is a real spawn, because the exec in
 * askSwitchboard is deliberately not injectable. So this points SWITCHBOARD_BIN
 * at a stand-in CLI script that echoes its argv back as the lane's reason, and
 * reads the answer through the whole pipeline: find the cli, spawn it, parse
 * the reply, look the account up in the accounts file. What it proves is that
 * dry-run is asked with --with-token (opt-in on Switchboard's side, so
 * forgetting the flag would silently lose the whole feature while everything
 * still passed), and that a token in the reply survives the trip.
 */
describe("asking a stand-in switchboard for real", () => {
  let dir: string;
  const prior = {
    SWITCHBOARD_BIN: process.env.SWITCHBOARD_BIN,
    APPDATA: process.env.APPDATA,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    SWITCHBOARD_ENABLED: process.env.SWITCHBOARD_ENABLED,
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-switchboard-cli-"));
    resetSwitchboardCache();
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetSwitchboardCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("sends --with-token and carries the answered token home", async () => {
    const home = path.join(dir, "lane-home");
    fs.mkdirSync(home, { recursive: true });
    const script = path.join(dir, "fake-switchboard-cli.js");
    fs.writeFileSync(
      script,
      [
        "// Echoes the argv it was called with as the lane's reason, so the",
        "// test on the other side can see exactly what Paperclip sent.",
        "process.stdout.write(JSON.stringify({",
        "  available: true,",
        "  laneId: 'lane-echo',",
        "  harness: 'claude',",
        "  provider: 'anthropic',",
        "  accountId: 'claude-echo',",
        "  reason: process.argv.slice(2).join(' '),",
        "  token: 'tok-from-cli',",
        "}) + '\\n');",
      ].join("\n"),
      "utf8",
    );
    fs.mkdirSync(path.join(dir, "Switchboard"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "Switchboard", "accounts.json"),
      JSON.stringify({ accounts: [{ id: "claude-echo", provider: "claude", label: "Echo", home }] }),
      "utf8",
    );
    process.env.SWITCHBOARD_BIN = script;
    process.env.APPDATA = dir;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.SWITCHBOARD_ENABLED;
    resetSwitchboardCache();

    const chosen = await switchboardAccountFor("claude", {});
    expect(chosen?.reason).toBe("dry-run --provider anthropic --json --with-token");
    expect(chosen?.token).toBe("tok-from-cli");
    expect(chosen?.accountId).toBe("claude-echo");
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
