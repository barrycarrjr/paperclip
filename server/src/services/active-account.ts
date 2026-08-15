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
