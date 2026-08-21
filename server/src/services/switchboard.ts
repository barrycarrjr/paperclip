/**
 * Switchboard, the machine's account broker, as a source of sign-ins.
 *
 * Switchboard (https://github.com/barrycarrjr/switchboard) holds this machine's
 * AI subscriptions as "lanes" and knows, per tool, which account is signed in
 * and still has allowance. Paperclip wants that knowledge for one reason,
 * recorded here because it is the whole justification for this file:
 *
 * On 2026-08-21 every agent across eight companies failed with "OAuth session
 * expired and could not be refreshed", for twelve hours, while a perfectly
 * healthy second Claude account sat on the same machine with a full week of
 * allowance left. Switchboard already knew: it had the dead account marked
 * "Not signed in" and the good one marked "Signed in". Paperclip could not ask,
 * so it kept spending runs on the dead one.
 *
 * What this does NOT do, deliberately: it never moves work to a different tool.
 * An agent configured for Claude keeps running on Claude. Paperclip's saved
 * sessions, prompt bundle and tool wiring are per-adapter, so handing a
 * half-finished Claude conversation to Codex would lose the thread rather than
 * rescue it. Choosing between the accounts of ONE tool is safe because those
 * are genuinely interchangeable, which is the same reason Paperclip's own
 * multi-account failover is safe (see services/adapter-accounts.ts).
 *
 * Order of precedence, highest first:
 *   1. A credential pinned onto the agent itself. Never re-routed.
 *   2. An account in Paperclip's own list (adapter-accounts.json).
 *   3. Switchboard's answer, if Switchboard is installed and has a lane.
 *   4. Whatever sign-in the machine already had. Unchanged, as today.
 *
 * So an install that has never heard of Switchboard behaves exactly as it does
 * now, and so does one where Switchboard is installed but has no lanes set up.
 *
 * @module server/services/switchboard
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { logger } from "../middleware/logger.js";

const exec = promisify(execFile);
const log = logger.child({ service: "switchboard" });

/**
 * How long Paperclip will wait to be told which account to use. This runs
 * before a run is spawned, so it has to be short: Switchboard not answering
 * must cost a moment, not a run. An Electron binary in --run-as-node mode
 * starts in well under a second once warm.
 */
const LANE_TIMEOUT_MS = 8000;

/**
 * How long an answer is reused before asking again. Switchboard checks live
 * quota over the network to answer, so asking once per run would add that cost
 * to every wake-up; and the answer only changes when an account runs out or is
 * signed in again, neither of which is a per-second event.
 */
const ANSWER_TTL_MS = 60_000;

/**
 * The four tools Switchboard can move between folders, how each one is told
 * which folder to use, and the name its lanes are filed under. Mirrors
 * PROVIDERS in Switchboard's own core/accounts.js; kept as data here so
 * Paperclip needs no dependency on it.
 *
 * `envShape` is the first wrinkle: two of these variables name the account
 * folder itself and two name the folder ABOVE it, so Gemini's
 * `GEMINI_CLI_HOME=C:\profiles\work` means the account lives in
 * `C:\profiles\work\.gemini`. Getting that backwards points a tool at a folder
 * it will never read, which fails exactly like being signed out.
 *
 * `vendor` is the second, and it is the one that silently returns nothing. A
 * Switchboard lane records BOTH names: `harness` is the tool ("claude"), and
 * `provider` is who sells the model ("anthropic"). In shipped Switchboard up to
 * 0.10.3, `dry-run --provider` filters on the vendor name only, so asking for
 * `--provider claude` matches no lane at all and reads as "nothing has
 * capacity". Verified against a real three-lane setup on 2026-08-21: `anthropic`
 * selects the Claude lane, `openai` the Codex lane, and `claude` and `codex`
 * select nothing. The mapping is Switchboard's own, from the line in
 * src/ui/index.html that builds a lane from an account.
 *
 * A later Switchboard accepts either name. The vendor name is still what gets
 * sent, because it is the one that works against BOTH: sending the tool name
 * would break on every copy already installed.
 */
const PROVIDER_ENV: Record<
  string,
  { envVar: string; envShape: "home" | "parent"; vendor: string }
> = {
  claude: { envVar: "CLAUDE_CONFIG_DIR", envShape: "home", vendor: "anthropic" },
  codex: { envVar: "CODEX_HOME", envShape: "home", vendor: "openai" },
  gemini: { envVar: "GEMINI_CLI_HOME", envShape: "parent", vendor: "google" },
  // Switchboard has no vendor alias for Qwen; the account provider is used as-is.
  qwen: { envVar: "QWEN_HOME", envShape: "home", vendor: "qwen" },
};

/**
 * Subscription tokens that outrank a config-folder sign-in and so must be
 * cleared when an account is chosen by folder. Without this the choice is
 * silently ignored: a stale token in the host environment wins, the tool signs
 * in as whoever that token belongs to, and the log still says the chosen
 * account was used. Paperclip persists exactly such a token to the Windows user
 * environment when someone uses the Adapters sign-in button, so this is the
 * normal case here, not a corner one.
 *
 * A subset of CLAUDE_CREDENTIAL_ENV_VARS in Switchboard's core/accounts.js.
 * The API-key variables are deliberately NOT here: an API key is a different,
 * deliberate way to pay for the work, and clearing one would quietly move an
 * operator off it. Those are handled by declining to re-route at all, in
 * `hasDeliberateApiKey` below.
 */
const CLAUDE_SUBSCRIPTION_TOKEN_VARS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CCR_OAUTH_TOKEN_FILE",
] as const;

/**
 * Anthropic API-key variables. Their presence means the operator chose to pay
 * per token rather than run on a subscription, and choosing a subscription
 * folder for them would be Paperclip overriding a decision it was never asked
 * to make. So when one of these is set, Switchboard is not consulted at all.
 */
const ANTHROPIC_API_KEY_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

/** True when this machine is deliberately running Claude on an API key. */
export function hasDeliberateApiKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return ANTHROPIC_API_KEY_VARS.some((name) => String(env[name] ?? "").trim().length > 0);
}

/**
 * Has this machine opted out? Its own function because two callers want the
 * same answer for different reasons: resolution has to return nothing, and any
 * later status surface has to be able to say "switched off" rather than "not
 * installed", which would send someone off to install what is already there.
 *
 * Deliberately the same variable name the ACS Slack bridge uses, so one
 * setting turns brokering off for everything on the machine at once.
 */
export function switchboardOptedOut(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.SWITCHBOARD_ENABLED || "").trim().toLowerCase() === "false";
}

export interface SwitchboardCli {
  /** The executable to spawn. */
  bin: string;
  /** Arguments that come before the subcommand. */
  prefixArgs: string[];
  /** Environment additions the executable needs. */
  env: Record<string, string>;
  /** How it was found, for the log line. */
  source: string;
}

/**
 * Where Switchboard's CLI might be, and how to launch each form.
 *
 * Deliberately NOT the .cmd shim, even though that is what a person types. The
 * shim forwards its arguments through cmd.exe with %*, and handing a batch
 * parser arguments Paperclip built is how quoting bugs and metacharacter
 * surprises happen. The shim's three lines are trivially inlined instead: set
 * ELECTRON_RUN_AS_NODE and give the Electron binary the cli.js path, after
 * which every argument is passed verbatim.
 *
 * Pure apart from the injected `exists`, so the search order is testable
 * without installing anything.
 */
export function findSwitchboardCli({
  env = process.env,
  platform = process.platform,
  exists = existsSync,
}: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
} = {}): SwitchboardCli | null {
  // Per-machine off switch. An operator whose Switchboard is half-configured,
  // or who simply does not want their agents brokered, sets this and Paperclip
  // runs exactly as it did before any of this existed.
  if (switchboardOptedOut(env)) return null;

  // An explicit path always wins, and it is also how to point Paperclip at a
  // development checkout (SWITCHBOARD_BIN=C:\Users\me\switchboard\bin\cli.js)
  // to try a change before it is packaged into a release.
  const explicit = String(env.SWITCHBOARD_BIN || "").trim();
  if (explicit) {
    return explicit.toLowerCase().endsWith(".js")
      ? { bin: process.execPath, prefixArgs: [explicit], env: {}, source: "SWITCHBOARD_BIN (script)" }
      : { bin: explicit, prefixArgs: [], env: {}, source: "SWITCHBOARD_BIN" };
  }

  // The installed desktop app. Its CLI is not on PATH: the installer writes the
  // shim into the app's own bin directory and leaves PATH alone, so looking
  // only on PATH would conclude Switchboard is absent on the very machine it is
  // running on.
  const roots: string[] = [];
  if (platform === "win32") {
    if (env.LOCALAPPDATA) roots.push(path.join(env.LOCALAPPDATA, "Programs", "switchboard"));
    if (env.PROGRAMFILES) roots.push(path.join(env.PROGRAMFILES, "switchboard"));
  } else if (platform === "darwin") {
    roots.push("/Applications/Switchboard.app/Contents");
  }

  for (const root of roots) {
    const bin = platform === "win32"
      ? path.join(root, "Switchboard.exe")
      : path.join(root, "MacOS", "Switchboard");
    if (!exists(bin)) continue;
    const resources = path.join(root, platform === "win32" ? "resources" : "Resources");
    // The app's code normally lives inside an asar archive. Electron reads a
    // path THROUGH that archive as if it were a directory, but ordinary Node
    // cannot: asar/bin/cli.js does not exist on disk, so testing for it would
    // decide Switchboard is absent on a machine where it is installed and
    // working. So the archive itself is what gets checked, while the path
    // handed to Electron still points inside it. An unpacked build (asar
    // disabled) is checked second so a locally built copy is also found.
    const asar = path.join(resources, "app.asar");
    const unpacked = path.join(resources, "app", "bin", "cli.js");
    const cli = exists(asar)
      ? path.join(asar, "bin", "cli.js")
      : exists(unpacked)
        ? unpacked
        : "";
    if (cli) {
      return {
        bin,
        prefixArgs: [cli],
        env: { ELECTRON_RUN_AS_NODE: "1" },
        source: "installed app",
      };
    }
  }
  return null;
}

// Resolved once per process. Detection touches the filesystem and the answer
// cannot change without the server being restarted (an install or an uninstall
// is not a live event), so paying for it on every run would be waste.
let resolvedCli: SwitchboardCli | null | undefined;

/** The Switchboard CLI on this machine, or null. Memoised. */
export function switchboardCli(env: NodeJS.ProcessEnv = process.env): SwitchboardCli | null {
  if (resolvedCli === undefined) {
    resolvedCli = findSwitchboardCli({ env });
    if (resolvedCli) {
      log.info(
        { source: resolvedCli.source, bin: resolvedCli.bin },
        "Switchboard found; adapters with no account of their own will ask it which account to sign in with",
      );
    }
  }
  return resolvedCli;
}

export interface SwitchboardAccount {
  /** Switchboard's id for the account, e.g. "claude-account-2". */
  accountId: string;
  /** The account's own label, for the run log. */
  label: string;
  /** The account's config folder on disk. */
  home: string;
  /** The variable that points the tool at that folder. */
  envVar: string;
  /** What to set it to: the folder, or its parent, per the tool's shape. */
  envValue: string;
  /** The lane Switchboard picked, for the run log. */
  laneId: string;
  /** Switchboard's own words for why, for the run log. */
  reason: string;
}

/** One registered account, as Switchboard's own data file records it. */
interface RegisteredAccount {
  id: string;
  provider: string;
  label: string;
  home: string;
}

/**
 * Where Switchboard keeps its account registrations. Read as a file rather than
 * asked for over the CLI because `switchboard status` checks live quota for
 * every account over the network to answer, and all that is wanted here is the
 * folder a chosen account lives in. Mirrors dataDir() in its core/paths.js.
 */
export function switchboardAccountsFile(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.APPDATA || path.join(homedir(), ".config");
  return path.join(base, "Switchboard", "accounts.json");
}

/**
 * The registered accounts, keyed by id. An unreadable or unfamiliar file gives
 * an empty map rather than throwing: not knowing the folders means Paperclip
 * declines to re-route, which is the same safe outcome as Switchboard being
 * absent.
 */
export function readRegisteredAccounts(
  env: NodeJS.ProcessEnv = process.env,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
): Map<string, RegisteredAccount> {
  const out = new Map<string, RegisteredAccount>();
  try {
    const parsed = JSON.parse(read(switchboardAccountsFile(env))) as unknown;
    const accounts = (parsed as { accounts?: unknown })?.accounts;
    if (!Array.isArray(accounts)) return out;
    for (const raw of accounts) {
      if (!raw || typeof raw !== "object") continue;
      const account = raw as Partial<RegisteredAccount>;
      if (
        typeof account.id !== "string" || !account.id ||
        typeof account.provider !== "string" || !account.provider ||
        typeof account.home !== "string" || !account.home
      ) continue;
      out.set(account.id, {
        id: account.id,
        provider: account.provider,
        label: typeof account.label === "string" && account.label ? account.label : account.id,
        home: account.home,
      });
    }
  } catch {
    // Not installed, never configured, or a shape this version does not know.
  }
  return out;
}

/**
 * What Switchboard's `dry-run --json` says. Only the fields Paperclip reads
 * are named; the rest of the reply is deliberately ignored so a later
 * Switchboard can add to it without breaking this.
 */
export function parseSwitchboardLane(stdout: string): {
  laneId: string;
  /** The tool the lane runs, e.g. "claude". This is what Paperclip matches on. */
  harness: string;
  /** Who sells the model, e.g. "anthropic". What `--provider` filters on. */
  provider: string;
  accountId: string;
  reason: string;
} | null {
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (parsed.available !== true) continue;
      const laneId = typeof parsed.laneId === "string" ? parsed.laneId : "";
      const provider = typeof parsed.provider === "string" ? parsed.provider : "";
      const accountId = typeof parsed.accountId === "string" ? parsed.accountId : "";
      if (!laneId || !provider || !accountId) continue;
      return {
        laneId,
        harness: typeof parsed.harness === "string" ? parsed.harness : "",
        provider,
        accountId,
        reason: typeof parsed.reason === "string" ? parsed.reason : "",
      };
    } catch {
      // Not the JSON line; keep looking.
    }
  }
  return null;
}

/** Cached answers per provider, so a burst of wake-ups asks once. */
const answerCache = new Map<string, { at: number; account: SwitchboardAccount | null }>();

/**
 * The last account Switchboard actually named for each tool, kept longer than
 * the ordinary answer.
 *
 * Switchboard decides a lane's health from a live quota fetch, and reports a
 * lane as unusable when that fetch merely fails: the same signed-in account can
 * read "Subscription has capacity" and "Quota state is unknown or unreadable"
 * two minutes apart. When that happens for every lane of a tool, Switchboard
 * says nothing is available, which is indistinguishable from every account
 * being genuinely spent.
 *
 * Falling all the way back to the machine's inherited sign-in on that answer is
 * the worst of the options, because that sign-in is exactly the one that may be
 * dead - it is what caused the outage this module exists to prevent. Reusing the
 * account Switchboard named a few minutes ago is strictly better: if it really
 * has run out, the run fails as plan_exhausted, which Paperclip already handles
 * by moving or parking the work, rather than as a signed-out failure, which it
 * does not.
 */
const lastGoodAnswer = new Map<string, { at: number; account: SwitchboardAccount }>();

/**
 * How long a previously-named account stands in for a momentary "nothing
 * available". Long enough to ride out a failed quota fetch, short enough that a
 * real change of circumstances is picked up within the hour.
 */
const LAST_GOOD_TTL_MS = 30 * 60_000;

/** Forget the memoised CLI path and every cached answer. Tests only. */
export function resetSwitchboardCache(): void {
  resolvedCli = undefined;
  answerCache.clear();
  lastGoodAnswer.clear();
}

/**
 * Which account should this tool sign in with right now?
 *
 * Returns null for every unhappy answer there is: no Switchboard, no lane with
 * capacity, no lanes configured at all, a Switchboard too old to speak JSON, a
 * timeout, a crash, an account it names that is not registered. All of them
 * mean the same thing to the caller, which is "sign in the way you always did",
 * and none of them may take a run down. That is why nothing here throws.
 *
 * The one exception is a tool Switchboard has named an account for recently:
 * see lastGoodAnswer above for why a momentary "nothing available" is answered
 * with that account rather than with nothing.
 */
export async function switchboardAccountFor(
  provider: string,
  {
    now = Date.now(),
    cwd,
    // Injected so the caching and fall-back-to-last-good rules can be tested
    // without a Switchboard on the machine running the suite.
    ask = askSwitchboard,
  }: {
    now?: number;
    cwd?: string;
    ask?: (
      provider: string,
      providerEnv: { envVar: string; envShape: "home" | "parent"; vendor: string },
      cwd: string | undefined,
    ) => Promise<SwitchboardAccount | null>;
  } = {},
): Promise<SwitchboardAccount | null> {
  const providerEnv = PROVIDER_ENV[provider];
  if (!providerEnv) return null;
  // An API key is a deliberate choice to pay per token. Overriding it with a
  // subscription folder would silently change how the work is billed.
  if (provider === "claude" && hasDeliberateApiKey()) return null;

  const cached = answerCache.get(provider);
  if (cached && now - cached.at < ANSWER_TTL_MS) return cached.account;

  const account = await ask(provider, providerEnv, cwd);
  answerCache.set(provider, { at: now, account });
  if (account) {
    lastGoodAnswer.set(provider, { at: now, account });
    return account;
  }

  const previous = lastGoodAnswer.get(provider);
  if (previous && now - previous.at < LAST_GOOD_TTL_MS) {
    log.debug(
      { provider, account: previous.account.label, agedMs: now - previous.at },
      "Switchboard named no account this time; reusing the one it named a few minutes ago",
    );
    return previous.account;
  }
  return null;
}

async function askSwitchboard(
  provider: string,
  providerEnv: { envVar: string; envShape: "home" | "parent"; vendor: string },
  cwd: string | undefined,
): Promise<SwitchboardAccount | null> {
  const cli = switchboardCli();
  if (!cli) return null;

  let stdout = "";
  try {
    // The vendor name, not the tool name: see PROVIDER_ENV. Asking for the tool
    // name matches no lane and comes back looking like "nothing has capacity".
    const result = await exec(cli.bin, [...cli.prefixArgs, "dry-run", "--provider", providerEnv.vendor, "--json"], {
      cwd,
      env: { ...process.env, ...cli.env },
      timeout: LANE_TIMEOUT_MS,
      windowsHide: true,
      encoding: "utf8",
    });
    stdout = result.stdout;
  } catch (err) {
    // A non-zero exit is Switchboard's own way of saying no lane is available,
    // so this is an ordinary answer rather than an error worth shouting about.
    // execFile still puts the output on the error, so read it before giving up:
    // that is what tells "no account has room" apart from "not installed".
    stdout = String((err as { stdout?: unknown })?.stdout ?? "");
    if (!stdout) {
      log.debug(
        { provider, err: err instanceof Error ? err.message : String(err) },
        "Switchboard named no account; leaving the existing sign-in alone",
      );
      return null;
    }
  }

  const lane = parseSwitchboardLane(stdout);
  if (!lane) return null;
  // Matched on the TOOL, not the vendor. The vendor filter above narrows the
  // pool, but this is the check that actually keeps a run on the tool it was
  // set up for, and it still holds if Switchboard ever widens what --provider
  // accepts. An older Switchboard that does not report a harness is judged on
  // the vendor instead rather than being refused outright.
  const laneTool = lane.harness || (lane.provider === providerEnv.vendor ? provider : lane.provider);
  if (laneTool !== provider) {
    // Asked about one tool and told about another. Paperclip does not move work
    // between tools, so this is declined rather than acted on.
    log.debug(
      { asked: provider, offered: laneTool, laneId: lane.laneId },
      "Switchboard offered a different tool than the one asked about; declining",
    );
    return null;
  }

  const registered = readRegisteredAccounts().get(lane.accountId);
  if (!registered) {
    log.warn(
      { accountId: lane.accountId, provider },
      "Switchboard named an account that is not in its own accounts file; leaving the existing sign-in alone",
    );
    return null;
  }

  const home = path.resolve(registered.home);
  return {
    accountId: registered.id,
    label: registered.label,
    home,
    envVar: providerEnv.envVar,
    envValue: providerEnv.envShape === "parent" ? path.dirname(home) : home,
    laneId: lane.laneId,
    reason: lane.reason,
  };
}

/**
 * The environment additions that put a run on a Switchboard-chosen account:
 * the folder variable, plus empty strings for anything that would outrank it.
 *
 * The empty strings are not cosmetic. Paperclip's buildSpawnChildEnv treats an
 * explicitly supplied empty value as "force this off for this spawn", which is
 * the only way to stop a machine-wide token from quietly signing the run in as
 * a different account than the one chosen here.
 */
export function switchboardAccountEnv(account: SwitchboardAccount): Record<string, string> {
  const env: Record<string, string> = { [account.envVar]: account.envValue };
  if (account.envVar === "CLAUDE_CONFIG_DIR") {
    for (const name of CLAUDE_SUBSCRIPTION_TOKEN_VARS) env[name] = "";
  }
  return env;
}
