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
import { switchboardAccountEnv, switchboardAccountFor } from "./switchboard.js";

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
  const own = await resolveActiveAccount(adapterType, now);
  if (own) {
    return {
      source: "paperclip",
      env: { [own.envVar]: own.credential },
      slot: own.slot,
      label: own.label,
      reason: null,
    };
  }

  const provider = switchboardProviderFor(adapterType);
  if (!provider) return null;
  const chosen = await switchboardAccountFor(provider, { now });
  if (!chosen) return null;

  return {
    source: "switchboard",
    env: switchboardAccountEnv(chosen),
    slot: null,
    label: chosen.label,
    reason: chosen.reason,
  };
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
