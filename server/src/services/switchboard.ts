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
 * Between 3 and 4 sits one more step, for a Switchboard that is installed and
 * working but names nothing this time: the account it named most recently, for
 * up to a day, or until a run on it fails to sign in (see lastGoodAnswer and
 * forgetSwitchboardAccount). Only when there is no such account does a
 * run reach 4, and then it is no longer silent: the change is logged as a
 * warning once, and the run records it (see switchboardAnswerFor). That is the
 * lesson of 2026-09-18, when an agent ran four times on the machine's expired
 * sign-in and nothing anywhere said Switchboard had been asked and had named
 * nobody.
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
 * The variables through which a run's own configuration can say how a tool
 * signs in, apart from the folder variable in PROVIDER_ENV: its API keys, and
 * for Claude the subscription tokens too. Each list is what that tool's adapter
 * itself treats as a credential (the billing-type checks in the claude-local,
 * codex-local and gemini-local execute.ts). Qwen has no adapter that asks
 * Switchboard yet, so only its folder variable counts.
 */
const PROVIDER_OWN_CREDENTIAL_VARS: Record<string, readonly string[]> = {
  claude: [...ANTHROPIC_API_KEY_VARS, ...CLAUDE_SUBSCRIPTION_TOKEN_VARS],
  codex: ["OPENAI_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};

/**
 * Does a run's own environment already say how this tool signs in?
 *
 * `env` is the run's merged environment (the agent's adapter env with project
 * and issue overrides applied), before anything Switchboard chose is added.
 * When it names a key, a token or a config folder of its own, a sign-in failure
 * on that run may be that credential's fault, not the fault of the account
 * Switchboard named or of the sign-in the server inherited, so nothing is
 * recorded or explained as either. Two older checks miss these: the heartbeat's
 * pinned-credential check sees only the one variable an adapter declares for
 * Paperclip's own account list, which Codex and Gemini do not declare at all,
 * and hasDeliberateApiKey reads only the server's own environment.
 *
 * Reads presence, never a value, and ignores blanks, because an empty value is
 * Paperclip's own way of switching a variable off for one spawn.
 */
export function envCarriesOwnSignIn(provider: string, env: Record<string, unknown>): boolean {
  const names = [...(PROVIDER_OWN_CREDENTIAL_VARS[provider] ?? [])];
  const folder = PROVIDER_ENV[provider]?.envVar;
  if (folder) names.push(folder);
  return names.some((name) => {
    const value = env[name];
    return typeof value === "string" && value.trim().length > 0;
  });
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
  /**
   * A long-lived token minted for this lane, for automation to authenticate
   * with instead of opening the folder's own sign-in. Null means run in folder
   * mode, which is exactly what every run did before tokens existed. Never
   * logged and never kept past the short answer cache: see lastGoodAnswer.
   */
  token: string | null;
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
 * are named (laneId, harness, provider, accountId, reason, and the optional
 * token); the rest of the reply is deliberately ignored so a later Switchboard
 * can add to it without breaking this.
 */
export function parseSwitchboardLane(stdout: string): {
  laneId: string;
  /** The tool the lane runs, e.g. "claude". This is what Paperclip matches on. */
  harness: string;
  /** Who sells the model, e.g. "anthropic". What `--provider` filters on. */
  provider: string;
  accountId: string;
  reason: string;
  /** The lane's token, when the reply carries a usable one. See SwitchboardAccount. */
  token: string | null;
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
      // The token is accepted on content, not presence. A reply serialised
      // with `token: null`, or with an empty or blank string, means the same
      // as no token at all; a presence check here would put the literal text
      // "null" into the child environment and sign the run in as nobody.
      const token = parsed.token;
      return {
        laneId,
        harness: typeof parsed.harness === "string" ? parsed.harness : "",
        provider,
        accountId,
        reason: typeof parsed.reason === "string" ? parsed.reason : "",
        token: typeof token === "string" && token.trim().length > 0 ? token : null,
      };
    } catch {
      // Not the JSON line; keep looking.
    }
  }
  return null;
}

/** The longest reason repeated into a log line or a run record. */
const MAX_REASON_CHARS = 200;

function capReason(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_REASON_CHARS ? `${oneLine.slice(0, MAX_REASON_CHARS - 3)}...` : oneLine;
}

/**
 * Why a reply from Switchboard named no account, in words fit for a warning
 * and a run record.
 *
 * Only ever called on output parseSwitchboardLane has already turned down, so
 * it never decides whether an answer is usable, only says why it was not.
 * Switchboard's own `reason` is repeated whenever the reply carries one,
 * because it is the only party that knows ("Quota state is unknown or
 * unreadable" and "No lanes are configured." ask different things of a
 * person). It is repeated, never interpreted: parseSwitchboardLane treats
 * every unavailable answer alike on purpose, and this keeps it that way.
 *
 * Raw output is never echoed, only the parsed `reason` field. The reply can
 * carry a lane token (--with-token), and a half-written JSON line cut off by
 * the timeout would otherwise put that secret straight into the log.
 */
export function describeSwitchboardRefusal(stdout: string): string {
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return "Switchboard printed nothing";
  let answeredWithoutAccount = false;
  for (const text of lines) {
    if (!text.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const reply = parsed as Record<string, unknown>;
    if (reply.available === true) {
      // Said yes but left out the lane, the vendor or the account, which is
      // why parseSwitchboardLane turned it down. Keep looking for a "no".
      answeredWithoutAccount = true;
      continue;
    }
    const reason = typeof reply.reason === "string" ? capReason(reply.reason) : "";
    return reason || "Switchboard said no account is available, without saying why";
  }
  return answeredWithoutAccount
    ? "Switchboard answered without naming a lane and an account"
    : "Switchboard's answer was not the JSON Paperclip asked for";
}

/**
 * Why asking Switchboard failed outright, when it printed nothing at all to
 * read a reason from. A timeout is named as one because it is the likeliest
 * cause and the one a person can do something about. Anything else gets the
 * first line of what Switchboard wrote to stderr, which is where an Electron
 * app reports a crash; the lane token only ever travels on stdout.
 */
function describeAskFailure(err: unknown): string {
  const failure = (err ?? {}) as { killed?: unknown; code?: unknown; stderr?: unknown };
  if (failure.killed === true) {
    return `Switchboard did not answer within ${LANE_TIMEOUT_MS / 1000} seconds`;
  }
  const stderr = String(failure.stderr ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
  if (typeof failure.code === "number") {
    return stderr
      ? `Switchboard exited with code ${failure.code}: ${capReason(stderr)}`
      : `Switchboard exited with code ${failure.code} and printed nothing`;
  }
  const code = typeof failure.code === "string" && failure.code ? ` (${failure.code})` : "";
  return `Switchboard could not be started${code}`;
}

/**
 * Switchboard was there to ask, and named no account this run may use.
 *
 * Kept apart from a plain null on purpose. Null still means "there is no
 * Switchboard to ask" (not installed, or switched off), which is how every
 * install behaved before this existed and is not worth a word. This means
 * Switchboard is installed and working and said no, which is exactly the
 * situation that went unreported on 2026-09-18.
 *
 * `available: false` mirrors Switchboard's own reply, and is also what tells
 * this apart from a SwitchboardAccount, which never carries the field.
 */
export interface SwitchboardNoAccount {
  available: false;
  /** Why, in Switchboard's own words when its reply carried any. */
  reason: string;
}

/** Everything asking Switchboard can come back with. Null: no Switchboard to ask. */
export type SwitchboardReply = SwitchboardAccount | SwitchboardNoAccount | null;

function isNoAccount(reply: SwitchboardReply): reply is SwitchboardNoAccount {
  return reply !== null && "available" in reply && reply.available === false;
}

/** Cached answers per provider, so a burst of wake-ups asks once. */
const answerCache = new Map<string, { at: number; reply: SwitchboardReply }>();

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
 * account Switchboard named most recently is strictly better: if it really
 * has run out, the run fails as plan_exhausted, which Paperclip already handles
 * by moving or parking the work, rather than as a signed-out failure, which it
 * does not.
 *
 * What is remembered here never includes a lane token. A replayed answer can
 * be up to a day old (LAST_GOOD_TTL_MS), and replaying a possibly rotated or
 * revoked secret hard-fails the run it was meant to save, while replaying just
 * the folder pointer falls back to the well-understood file sign-in. The token
 * is stripped when the answer is stored, not when it is replayed, so no future
 * reader of this map can forget to.
 *
 * Held in memory only, so a server restart forgets it, and the first runs after
 * a restart during a Switchboard outage still reach the machine's own sign-in.
 * A run on the account that fails to sign in forgets it too: see
 * forgetSwitchboardAccount.
 */
const lastGoodAnswer = new Map<string, { at: number; account: SwitchboardAccount }>();

/**
 * How long a previously-named account stands in for a Switchboard that names
 * nothing.
 *
 * This was thirty minutes, sized for a single failed quota fetch. On
 * 2026-09-18 Switchboard named nothing for about three hours; the remembered
 * account had lapsed long before a new-mail wake at 19:17 UTC, so four runs in
 * a row signed in with the machine's own sign-in, which had expired, and the
 * agent sat in error for ten days. Thirty minutes protected against the short
 * blip and not against the long one, and the long one is what did the damage.
 *
 * A day, because the remembered account is the last one Switchboard judged
 * healthy, and the machine's own sign-in is the one nothing vouches for. If the
 * remembered account has since run out, the run fails as plan_exhausted, which
 * Paperclip already handles. Nor does the length delay a real change: a fresh
 * answer from Switchboard always wins the moment it arrives, so this only
 * decides how long a SILENT Switchboard is bridged.
 *
 * The replay is not free, though, and an earlier version of this comment said
 * it could not do worse than the machine's own sign-in. It can. A replay runs
 * in folder mode, which blanks every Claude token variable (see
 * switchboardAccountEnv), so it also strips a fresh token someone saved
 * host-wide with the Adapters sign-in button. If Switchboard fell silent
 * because the remembered account was signed out, or because someone removed
 * that lane on purpose, every run for the rest of the day would go to a dead
 * folder while a working token sat unused, and fail with nothing on the record
 * to say why. Two things keep that short. The first run on the account that
 * fails to sign in makes Paperclip forget it (forgetSwitchboardAccount), so the
 * next run takes the machine's own sign-in, which is recorded and explained.
 * And a run on a reused account is recorded as one, so its own sign-in failure
 * is explained rather than bare. The cost is one failed run per dead account,
 * against three hours of failed runs in the incident above.
 *
 * Still bounded, so an account someone has deliberately taken out of
 * Switchboard is not used on the strength of an answer from last week; by the
 * time a day has passed the warning logged when the replay began has been
 * sitting there all day.
 */
const LAST_GOOD_TTL_MS = 24 * 60 * 60_000;

/**
 * What each tool's last answer amounted to, so the warning in noteState is
 * said once when things change rather than on every run: a Switchboard that is
 * down for three hours would otherwise write the same line for every wake-up
 * of every agent in that time.
 *
 * Keyed on which way the run went, not on Switchboard's exact wording, so a
 * reason that flips between two phrasings does not re-trigger it. The wording
 * of each run's reason is not lost: it goes on the run record instead.
 */
type SwitchboardState = "answered" | "recent_account" | "machine_sign_in";
const lastState = new Map<string, SwitchboardState>();

/** Forget the memoised CLI path and every cached answer. Tests only. */
export function resetSwitchboardCache(): void {
  resolvedCli = undefined;
  answerCache.clear();
  lastGoodAnswer.clear();
  lastState.clear();
}

/**
 * What Switchboard's answer means for one run.
 *
 * `account` is what to sign in with, and null still means "leave the machine's
 * own sign-in alone". `noAnswer` is set only when Switchboard was there to ask
 * and named nothing usable, and says what stood in for it: a recent account
 * (`recent_account`), or the machine's own sign-in (`machine_sign_in`). It is
 * null when Switchboard answered, and also when it was never asked (not
 * installed, switched off, an API key in use, a tool it cannot move), because
 * none of those is something going wrong.
 */
export interface SwitchboardAnswer {
  account: SwitchboardAccount | null;
  noAnswer:
    | {
        /** Why Switchboard named nothing, in its own words where it gave any. */
        reason: string;
        usedInstead: "machine_sign_in";
      }
    | {
        reason: string;
        usedInstead: "recent_account";
        /** How long ago Switchboard named the account being reused. */
        agedMs: number;
      }
    | null;
}

const NOT_ASKED: SwitchboardAnswer = { account: null, noAnswer: null };

/**
 * Log a change in how a tool's runs are signing in, once per change.
 *
 * WARN for both unhappy states, because both mean a run is not on an account
 * Switchboard currently vouches for, and the machine's own sign-in in
 * particular is the one that took an agent down on 2026-09-18 without a single
 * line at info or warn. Coming back is INFO: good news, but worth a line so the
 * warning has a visible end.
 */
function noteState(
  provider: string,
  state: SwitchboardState,
  detail: { reason?: string; account?: string; agedMs?: number } = {},
): void {
  const previous = lastState.get(provider);
  lastState.set(provider, state);
  if (previous === state) return;
  if (state === "answered") {
    // The first answer after a start-up is the normal case and says nothing;
    // "Switchboard found" has already been logged by then.
    if (previous) log.info({ provider }, "Switchboard is naming an account again");
    return;
  }
  if (state === "recent_account") {
    log.warn(
      {
        provider,
        reason: detail.reason,
        usedInstead: "recent_account",
        account: detail.account,
        agedMinutes: Math.round((detail.agedMs ?? 0) / 60_000),
      },
      "Switchboard named no usable account; runs will reuse the account it named most recently until it answers again",
    );
    return;
  }
  // "No recent account to reuse" covers both ways to get here: the last one
  // Switchboard named is more than a day old, or a run on it failed to sign in
  // and it was forgotten (see forgetSwitchboardAccount, which says so itself).
  log.warn(
    { provider, reason: detail.reason, usedInstead: "machine_sign_in" },
    "Switchboard named no usable account and there is no recent one to reuse; runs will use this machine's own sign-in, which may be expired",
  );
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
 *
 * Just the account, for callers that have nowhere to record why. The run path
 * uses switchboardAnswerFor, which also says when Switchboard named nothing.
 */
export async function switchboardAccountFor(
  provider: string,
  options: SwitchboardAskOptions = {},
): Promise<SwitchboardAccount | null> {
  return (await switchboardAnswerFor(provider, options)).account;
}

export interface SwitchboardAskOptions {
  now?: number;
  cwd?: string;
  /**
   * Injected so the caching and fall-back-to-last-good rules can be tested
   * without a Switchboard on the machine running the suite. Resolves to an
   * account, to SwitchboardNoAccount when Switchboard was asked and said no,
   * or to null when there is no Switchboard to ask.
   */
  ask?: (
    provider: string,
    providerEnv: { envVar: string; envShape: "home" | "parent"; vendor: string },
    cwd: string | undefined,
  ) => Promise<SwitchboardReply>;
}

/**
 * Which account should this tool sign in with right now, and if Switchboard
 * named none, what stood in for it. Same rules as switchboardAccountFor, which
 * is this without the second half.
 *
 * The second half exists because of 2026-09-18: Switchboard named no account
 * for about three hours, a run fell back to the machine's own expired sign-in
 * four times, and nothing about it was logged above debug level. So a
 * Switchboard that is installed but says no is now logged as a warning when it
 * starts (and an info line when it stops), and the caller is told, so the run
 * that falls back can carry the reason on its own record.
 */
export async function switchboardAnswerFor(
  provider: string,
  { now = Date.now(), cwd, ask = askSwitchboard }: SwitchboardAskOptions = {},
): Promise<SwitchboardAnswer> {
  const providerEnv = PROVIDER_ENV[provider];
  if (!providerEnv) return NOT_ASKED;
  // An API key is a deliberate choice to pay per token. Overriding it with a
  // subscription folder would silently change how the work is billed.
  if (provider === "claude" && hasDeliberateApiKey()) return NOT_ASKED;

  const cached = answerCache.get(provider);
  if (cached && now - cached.at < ANSWER_TTL_MS) {
    // A cached "no" gets the same last-good courtesy a fresh one gets, because
    // both go through settleReply. Without this, the first null of a
    // Switchboard hiccup shadowed the fallback for a full minute: the null was
    // cached, the cache was consulted first, and the still-valid last good
    // answer sat unused.
    return settleReply(provider, cached.reply, now);
  }

  const reply = await ask(provider, providerEnv, cwd);
  answerCache.set(provider, { at: now, reply });
  if (reply && !isNoAccount(reply)) {
    // Remembered without its token: see lastGoodAnswer above for why a stale
    // replay must run in folder mode rather than on a possibly dead secret.
    lastGoodAnswer.set(provider, { at: now, account: { ...reply, token: null } });
  }
  return settleReply(provider, reply, now);
}

/** Turn one reply, fresh or cached, into what the run should do. */
function settleReply(provider: string, reply: SwitchboardReply, now: number): SwitchboardAnswer {
  if (reply && !isNoAccount(reply)) {
    noteState(provider, "answered");
    return { account: reply, noAnswer: null };
  }
  const previous = lastGoodWithinTtl(provider, now);
  if (!reply) {
    // No Switchboard to ask. In practice there is then never a last good
    // answer either, because the CLI lookup is memoised for the life of the
    // process; the replay is kept for the same reason it always was, and
    // nothing is logged, because an install without Switchboard is not a
    // fault.
    return { account: previous?.account ?? null, noAnswer: null };
  }
  if (previous) {
    noteState(provider, "recent_account", {
      reason: reply.reason,
      account: previous.account.label,
      agedMs: previous.agedMs,
    });
    return {
      account: previous.account,
      noAnswer: { reason: reply.reason, usedInstead: "recent_account", agedMs: previous.agedMs },
    };
  }
  noteState(provider, "machine_sign_in", { reason: reply.reason });
  return { account: null, noAnswer: { reason: reply.reason, usedInstead: "machine_sign_in" } };
}

/** The last good answer, while it is still fresh, with how old it is. */
function lastGoodWithinTtl(
  provider: string,
  now: number,
): { account: SwitchboardAccount; agedMs: number } | null {
  const previous = lastGoodAnswer.get(provider);
  if (previous && now - previous.at < LAST_GOOD_TTL_MS) {
    log.debug(
      { provider, account: previous.account.label, agedMs: now - previous.at },
      "Switchboard named no account this time; reusing the one it named most recently",
    );
    return { account: previous.account, agedMs: now - previous.at };
  }
  return null;
}

/**
 * Stop reusing an account after a run on it failed to sign in.
 *
 * The replay above hands out the last account Switchboard named for up to a
 * day, in folder mode. If that account is what is broken (signed out, or its
 * lane removed on purpose, which is often exactly WHY Switchboard stopped
 * naming it), every replayed run fails to sign in, and each one also strips a
 * host-wide token that might have worked. So the first sign-in failure on the
 * account ends the reuse, and later runs take the machine's own sign-in, which
 * is recorded on the run and explained if it fails as well.
 *
 * Only the account the failed run was on is forgotten: Switchboard may have
 * named a different one since that run started, and that one has done nothing
 * wrong. A cached answer naming the failed account is dropped too, so the next
 * run asks Switchboard afresh instead of being handed the same folder for up to
 * another minute. If Switchboard names it again, that fresh answer wins as it
 * always does, because Switchboard is the one that can check.
 *
 * A sign-in failure is taken at its word, even though runs sharing one folder
 * can now and then trip over each other's token refresh. Wrongly forgetting a
 * healthy account costs the reuse until Switchboard next names an account;
 * wrongly keeping a dead one cost the incident recorded at LAST_GOOD_TTL_MS.
 *
 * Warns only when something was actually forgotten, so a burst of runs failing
 * on the same account writes one line, not one per run. Returns whether it did.
 */
export function forgetSwitchboardAccount(provider: string, accountId: string): boolean {
  let label: string | null = null;
  const remembered = lastGoodAnswer.get(provider);
  if (remembered && remembered.account.accountId === accountId) {
    lastGoodAnswer.delete(provider);
    label = remembered.account.label;
  }
  const cached = answerCache.get(provider)?.reply ?? null;
  if (cached && !isNoAccount(cached) && cached.accountId === accountId) {
    answerCache.delete(provider);
    label = label ?? cached.label;
  }
  if (label === null) return false;
  log.warn(
    { provider, account: label },
    "A run on the account Switchboard named could not sign in; Paperclip will not reuse that account unless Switchboard names it again",
  );
  return true;
}

async function askSwitchboard(
  provider: string,
  providerEnv: { envVar: string; envShape: "home" | "parent"; vendor: string },
  cwd: string | undefined,
): Promise<SwitchboardReply> {
  const cli = switchboardCli();
  if (!cli) return null;

  let stdout = "";
  try {
    // The vendor name, not the tool name: see PROVIDER_ENV. Asking for the tool
    // name matches no lane and comes back looking like "nothing has capacity".
    //
    // --with-token asks for the lane's token in the reply. It is opt-in on
    // Switchboard's side because other callers parse the same stdout and must
    // not start receiving secrets they never asked for. Safe to send always:
    // a Switchboard without the feature parses unknown flags as trailing
    // command arguments, which dry-run ignores, so the answer is unchanged.
    const result = await exec(cli.bin, [...cli.prefixArgs, "dry-run", "--provider", providerEnv.vendor, "--json", "--with-token"], {
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
      // Installed, asked, and no answer: a "no" with a reason rather than the
      // null that means "no Switchboard here", so it is reported. See
      // SwitchboardNoAccount.
      return { available: false, reason: describeAskFailure(err) };
    }
  }

  const lane = parseSwitchboardLane(stdout);
  if (!lane) return { available: false, reason: describeSwitchboardRefusal(stdout) };
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
    return { available: false, reason: `Switchboard offered a ${laneTool} lane, not ${provider}` };
  }

  const registered = readRegisteredAccounts().get(lane.accountId);
  if (!registered) {
    // This used to be its own warning, written on every ask (once a minute
    // while it lasted). The same fact now travels as the reason, so it is said
    // once by noteState along with which sign-in the run fell back to, and is
    // kept here at debug for anyone tracing a single ask.
    log.debug(
      { accountId: lane.accountId, provider },
      "Switchboard named an account that is not in its own accounts file; leaving the existing sign-in alone",
    );
    return {
      available: false,
      reason: `Switchboard named account "${lane.accountId}", which is not in its own accounts file`,
    };
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
    token: lane.token,
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
 *
 * When the lane carries a token, CLAUDE_CODE_OAUTH_TOKEN carries it instead of
 * being blanked. The token authenticates the run by itself, so the folder's
 * OAuth login is never opened, which is what stops a fleet of concurrent runs
 * refreshing the same login and wiping .credentials.json out from under each
 * other. The folder variable is still set either way, because it is what
 * points config, plugins, and workspace trust at the lane's folder; the token
 * only replaces the sign-in, not the home. Without a token the output is
 * exactly what it always was, which is the fallback the whole design leans on.
 */
export function switchboardAccountEnv(account: SwitchboardAccount): Record<string, string> {
  const env: Record<string, string> = { [account.envVar]: account.envValue };
  if (account.envVar === "CLAUDE_CONFIG_DIR") {
    for (const name of CLAUDE_SUBSCRIPTION_TOKEN_VARS) env[name] = "";
    if (typeof account.token === "string" && account.token.length > 0) {
      env.CLAUDE_CODE_OAUTH_TOKEN = account.token;
    }
  }
  return env;
}
