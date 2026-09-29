/**
 * The account an adapter is currently running work on.
 *
 * Three places need this and they must agree: the run path and the chat path
 * hand the credential to a spawned process, and the Adapters page asks the
 * adapter to describe that account's usage and sign-in. When they disagree the
 * page confidently describes an account nothing is using, which is exactly the
 * failure this module exists to prevent.
 *
 * Gated on the adapter having declared `accountCredentialEnvVar`. An adapter
 * that has not opted in keeps whatever sign-in the machine already had, even
 * if accounts happen to be stored against its type.
 *
 * @module server/services/active-account
 */

import { getServerAdapter } from "../adapters/index.js";
import { activeAccount, forgetExpiredAccountLimits } from "./adapter-account-router.js";
import { readAdapterAccountState } from "./adapter-accounts.js";
import {
  envCarriesOwnSignIn,
  forgetSwitchboardAccount,
  switchboardAccountEnv,
  switchboardAnswerFor,
} from "./switchboard.js";

/**
 * The environment variable this adapter's credential travels in, or null when
 * it has not opted into holding a list of accounts.
 */
export function accountCredentialEnvVarFor(adapterType: string): string | null {
  try {
    const envVar = getServerAdapter(adapterType).accountCredentialEnvVar;
    return typeof envVar === "string" && envVar.trim().length > 0 ? envVar.trim() : null;
  } catch {
    // An unknown or unloaded adapter simply has no account routing.
    return null;
  }
}

/**
 * The active account for an adapter, with the variable its credential belongs
 * in. Null when the adapter has no list, or the list is empty, or nothing in
 * it is usable.
 */
export async function resolveActiveAccount(
  adapterType: string,
  now = Date.now(),
): Promise<{ slot: string; label: string; envVar: string; credential: string } | null> {
  const envVar = accountCredentialEnvVarFor(adapterType);
  if (!envVar) return null;
  const state = forgetExpiredAccountLimits(await readAdapterAccountState(adapterType), now);
  const account = activeAccount(state);
  if (!account) return null;
  return { slot: account.slot, label: account.label, envVar, credential: account.token };
}

/** Just the credential, for callers that only need to ask a provider about it. */
export async function resolveActiveAccountCredential(
  adapterType: string,
): Promise<string | undefined> {
  return (await resolveActiveAccount(adapterType))?.credential;
}

/**
 * The name Switchboard knows this adapter's tool by, or null when the adapter
 * has not opted in.
 */
export function switchboardProviderFor(adapterType: string): string | null {
  try {
    const provider = getServerAdapter(adapterType).switchboardProvider;
    return typeof provider === "string" && provider.trim().length > 0 ? provider.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Where a run's sign-in comes from, said once so the run path, the chat path
 * and the Adapters page cannot disagree.
 *
 * `source` is what actually decided it, which the run log records so an
 * operator can tell "used the account I added" from "used the one Switchboard
 * picked" without guessing.
 */
export interface ResolvedAccountEnv {
  source: "paperclip" | "switchboard";
  /** Environment additions to put on the child. */
  env: Record<string, string>;
  /** Paperclip's own slot name, when this came from Paperclip's list. */
  slot: string | null;
  /** A human label for the run log. */
  label: string;
  /** Switchboard's own words for why, when it chose. */
  reason: string | null;
}

/**
 * Which account signs this adapter's next run in, and the environment that
 * puts the run on it.
 *
 * Precedence, and the reasoning for it:
 *   1. An account in Paperclip's own list. The operator added it here and
 *      expects it used; Paperclip's failover already moves between these when
 *      one runs out.
 *   2. Switchboard's answer. Only reached when Paperclip has no list of its
 *      own, so this never overrules an explicit local choice - it fills the
 *      case where Paperclip would otherwise use whichever sign-in the server
 *      inherited at launch, healthy or not.
 *   3. Null, meaning change nothing, which is how an install with neither
 *      keeps working exactly as before.
 *
 * A credential pinned onto the agent itself outranks all of this, and is
 * checked by the caller, which is the only place that knows the agent.
 */
export async function resolveAdapterAccountEnv(
  adapterType: string,
  now = Date.now(),
): Promise<ResolvedAccountEnv | null> {
  return (await resolveAdapterAccountForRun(adapterType, { now })).resolved;
}

/**
 * What a run records when Switchboard was asked, named no usable account, and
 * had named none recently enough to reuse, so the run is on whatever sign-in
 * the server inherited when it started.
 *
 * Stored on the run's context as `switchboardFallback`, next to
 * `switchboardAccount`, which it replaces: a run has one or the other. On
 * 2026-09-18 four runs in a row took this path with nothing on their record
 * to say so, only a missing `switchboardAccount`, which is also what a machine
 * with no Switchboard looks like.
 *
 * Only recorded when that really is the sign-in the run used: not when the
 * run's own environment names a key, token or folder for the tool (see
 * envCarriesOwnSignIn), and not on a remote target, which the heartbeat
 * removes it for once it knows where the run executes.
 */
export interface SwitchboardFallbackRecord {
  /** The tool Switchboard was asked about, e.g. "claude". */
  provider: string;
  /** Why it named nothing, in Switchboard's own words where it gave any. */
  reason: string;
}

/**
 * What a run records when Switchboard named nothing and the run was put on the
 * account it had named most recently instead.
 *
 * Stored on the run's context as `switchboardReplay`, alongside
 * `switchboardAccount`, which still names the account. Without it a reused
 * account that has since been signed out fails exactly like the 2026-09-18
 * runs did, with the adapter's bare words and nothing to say Switchboard had
 * gone quiet. Same conditions as SwitchboardFallbackRecord for being recorded.
 */
export interface SwitchboardReplayRecord {
  /** The tool Switchboard was asked about, e.g. "claude". */
  provider: string;
  /** The reused account's label, as `switchboardAccount` has it. */
  account: string;
  /** Why Switchboard named nothing this time. */
  reason: string;
  /** How long before this run Switchboard last named the account. */
  agedMinutes: number;
}

/** Everything the run path learns from resolving an account. */
export interface RunAccountResolution {
  resolved: ResolvedAccountEnv | null;
  switchboardFallback: SwitchboardFallbackRecord | null;
  switchboardReplay: SwitchboardReplayRecord | null;
  /**
   * The Switchboard account this run signs in with, freshly named or reused,
   * so a sign-in failure on it can stop it being reused (see
   * forgetSwitchboardAccountAfterSignInFailure). Null when the run is on
   * anything else, or when its own environment names a sign-in of its own,
   * because then a failure may be that credential's and not the account's.
   */
  switchboardAccountInUse: { provider: string; accountId: string } | null;
}

const NOTHING_TO_RECORD = {
  switchboardFallback: null,
  switchboardReplay: null,
  switchboardAccountInUse: null,
} as const;

/**
 * resolveAdapterAccountEnv for the run path, which also has somewhere to
 * record a fall back to the machine's own sign-in or to a reused account. The
 * other callers (chat, the model lists) have nowhere to put that, so they keep
 * the plain answer.
 *
 * `runEnv` is the run's merged environment before any account is added, and
 * only decides what is recorded, never which account is chosen: an agent whose
 * own env carries a key or a folder still gets Switchboard's answer exactly as
 * before, it just is not told that a sign-in failure was Switchboard's doing.
 */
export async function resolveAdapterAccountForRun(
  adapterType: string,
  { now = Date.now(), runEnv = {} }: { now?: number; runEnv?: Record<string, unknown> } = {},
): Promise<RunAccountResolution> {
  const own = await resolveActiveAccount(adapterType, now);
  if (own) {
    return {
      resolved: {
        source: "paperclip",
        env: { [own.envVar]: own.credential },
        slot: own.slot,
        label: own.label,
        reason: null,
      },
      ...NOTHING_TO_RECORD,
    };
  }

  const provider = switchboardProviderFor(adapterType);
  if (!provider) return { resolved: null, ...NOTHING_TO_RECORD };
  const { account: chosen, noAnswer } = await switchboardAnswerFor(provider, { now });
  const signsItselfIn = envCarriesOwnSignIn(provider, runEnv);
  if (!chosen) {
    return {
      resolved: null,
      ...NOTHING_TO_RECORD,
      switchboardFallback:
        noAnswer?.usedInstead === "machine_sign_in" && !signsItselfIn
          ? { provider, reason: noAnswer.reason }
          : null,
    };
  }

  return {
    resolved: {
      source: "switchboard",
      env: switchboardAccountEnv(chosen),
      slot: null,
      label: chosen.label,
      // A reused account keeps the reason Switchboard gave when it last named
      // it, which could be "Subscription has capacity" from hours ago. With the
      // replay window now a day long that would make the run log say the
      // opposite of what happened, so a reuse says it is one.
      reason:
        noAnswer?.usedInstead === "recent_account"
          ? `Reused the account Switchboard named most recently, because it named none just now: ${noAnswer.reason}`
          : chosen.reason,
    },
    switchboardFallback: null,
    switchboardReplay:
      noAnswer?.usedInstead === "recent_account" && !signsItselfIn
        ? {
            provider,
            account: chosen.label,
            reason: noAnswer.reason,
            agedMinutes: Math.round(noAnswer.agedMs / 60_000),
          }
        : null,
    switchboardAccountInUse: signsItselfIn ? null : { provider, accountId: chosen.accountId },
  };
}

/**
 * The error codes adapters write for a sign-in failure: `<adapter>_auth_required`,
 * the same code the run-failure guidance and the signed-out count read. Keyed on
 * the code so no error text is re-parsed here.
 */
function isSignInFailure(errorCode: string | null | undefined): boolean {
  return typeof errorCode === "string" && errorCode.endsWith("_auth_required");
}

/**
 * After a run finishes: if it was on an account Switchboard named and failed
 * to sign in, stop reusing that account while Switchboard names nothing. See
 * forgetSwitchboardAccount for why, and for why only that one account.
 *
 * `accountInUse` is RunAccountResolution's `switchboardAccountInUse`, which is
 * already null for a run whose own environment carried a sign-in, and which
 * the heartbeat clears for a run on a remote target: in both cases the failure
 * says nothing about the account on this computer. Returns whether anything
 * was forgotten.
 */
export function forgetSwitchboardAccountAfterSignInFailure(
  errorCode: string | null | undefined,
  accountInUse: { provider: string; accountId: string } | null,
): boolean {
  if (!accountInUse || !isSignInFailure(errorCode)) return false;
  return forgetSwitchboardAccount(accountInUse.provider, accountInUse.accountId);
}

/** "3 minutes earlier", "about 3 hours earlier": a replay's age for a person. */
function describeAge(minutes: number): string {
  if (minutes < 1) return "less than a minute earlier";
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? "" : "s"} earlier`;
  return `about ${Math.round(minutes / 60)} hours earlier`;
}

/**
 * A run's error message, with a plain explanation put in front when the run
 * was not on an account Switchboard vouched for at the time and its sign-in is
 * what failed. Two cases:
 *
 * - It fell back to the machine's own sign-in. Without the explanation the run
 *   said only "Failed to authenticate: OAuth session expired and could not be
 *   refreshed", which reads as "this agent's login broke" and sends a person
 *   looking at the agent, when the real story is that Switchboard had no
 *   account to give and the machine's own sign-in, which nothing was meant to
 *   be using, had long expired.
 * - It reused the account Switchboard named most recently, and that account
 *   could not sign in, often the very reason Switchboard stopped naming it.
 *   The run that fails this way also makes Paperclip stop reusing the account
 *   (forgetSwitchboardAccountAfterSignInFailure), which the message says.
 *
 * Keyed on the `<adapter>_auth_required` error code (see isSignInFailure). The
 * original message is kept whole after the explanation, so anything matching
 * on it still matches. The records are read back from the run context, which is
 * why they are taken as unknown and checked here.
 */
export function explainSwitchboardFallbackFailure(input: {
  errorMessage: string;
  errorCode: string | null | undefined;
  /** The run context's `switchboardFallback`, as read back from the context. */
  switchboardFallback: unknown;
  /** The run context's `switchboardReplay`, as read back from the context. */
  switchboardReplay?: unknown;
}): string {
  const { errorMessage, errorCode, switchboardFallback, switchboardReplay } = input;
  if (!isSignInFailure(errorCode)) return errorMessage;

  const fallback = readRecord(switchboardFallback);
  const replay = fallback ? null : readRecord(switchboardReplay);
  const record = fallback ?? replay;
  if (!record) return errorMessage;
  const tool = record.provider.charAt(0).toUpperCase() + record.provider.slice(1);
  const why = record.reason ? ` Why Switchboard had no account: ${record.reason}.` : "";

  if (fallback) {
    return (
      `Switchboard had no ${tool} account available when this run started, so the run used this computer's own ${tool} sign-in, which has expired or been signed out.` +
      `${why} Original error: ${errorMessage}`
    );
  }
  const raw = switchboardReplay as Partial<SwitchboardReplayRecord>;
  const account = typeof raw.account === "string" && raw.account.trim() ? `"${raw.account.trim()}"` : "the account";
  const age =
    typeof raw.agedMinutes === "number" && Number.isFinite(raw.agedMinutes) && raw.agedMinutes >= 0
      ? ` (${describeAge(Math.round(raw.agedMinutes))})`
      : "";
  return (
    `Switchboard had no ${tool} account available when this run started, so the run reused ${account}, the account Switchboard had named most recently${age}, and that account could not sign in. ` +
    `Paperclip will not reuse it again unless Switchboard names it.${why} Original error: ${errorMessage}`
  );
}

/** The provider and reason from a record read back off a run context, or null. */
function readRecord(value: unknown): { provider: string; reason: string } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { provider?: unknown; reason?: unknown };
  const provider = typeof record.provider === "string" ? record.provider.trim() : "";
  if (!provider) return null;
  const reason = typeof record.reason === "string" ? record.reason.trim().replace(/\.+$/, "") : "";
  return { provider, reason };
}

/**
 * The fields the "Switchboard chose the account for this run" log line may
 * carry, and nothing else.
 *
 * `resolved.env` stays out on purpose: when the lane carries a token, the env
 * holds a live credential, and a log line gets copied into log files, log
 * shippers and support pastes that a credential must never reach. Label and
 * reason are everything the line exists to say. The pinning test on this
 * helper is what keeps a later "just log the whole resolved object" edit from
 * quietly shipping the secret.
 */
export function switchboardChoiceLogFields(
  agentId: string,
  adapterType: string,
  resolved: ResolvedAccountEnv,
): { agentId: string; adapterType: string; account: string; reason: string | null } {
  return { agentId, adapterType, account: resolved.label, reason: resolved.reason };
}

/**
 * The resolved environment as a run's execution target may safely receive it.
 *
 * A remote target puts the run's environment in plain sight: the ssh
 * transport writes every entry as `env KEY=value` inside the `sh -lc` script
 * it builds (buildSshSpawnTarget in adapter-utils/ssh), so anything in here
 * shows up in process listings on both machines. A Switchboard lane token is
 * a live credential, so on a remote target it is forced back to the empty
 * string, which restores exactly the pre-token Switchboard environment: the
 * folder pointer with every token variable blanked. A Switchboard answer
 * describes accounts on THIS machine anyway, so the remote run loses nothing
 * it could have used. Carrying the token to a remote host without printing it
 * is a transport fix for another day.
 *
 * An account from Paperclip's own list is left alone even on a remote target:
 * the operator added that credential for runs to use, remote runs included,
 * and that is exactly how it behaved before lane tokens existed.
 */
export function resolvedEnvForExecution(
  resolved: ResolvedAccountEnv,
  isRemoteTarget: boolean,
): Record<string, string> {
  if (!isRemoteTarget || resolved.source !== "switchboard") return resolved.env;
  if (resolved.env.CLAUDE_CODE_OAUTH_TOKEN === undefined) return resolved.env;
  return { ...resolved.env, CLAUDE_CODE_OAUTH_TOKEN: "" };
}
