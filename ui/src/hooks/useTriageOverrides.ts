import { useSyncExternalStore } from "react";
import {
  helpScoutOverrideStore,
  imapOverrideStore,
  type HelpScoutOverrides,
  type ImapOverrides,
} from "../lib/mailboxTriageOverrides";

/**
 * Subscribe to the pending triage notes for one mailbox scope.
 *
 * Both the Portfolio Email panel and the per-company Email page call these, so
 * a row triaged on either screen is hidden on both the moment it's clicked.
 * See `lib/mailboxTriageOverrides.ts` for why the note lives outside react-query.
 *
 * Pass null while the mailbox is still being resolved; you get an empty (and
 * stable) map back.
 */
export function useImapTriageOverrides(scope: string | null): ImapOverrides {
  return useSyncExternalStore(
    imapOverrideStore.subscribe,
    () => imapOverrideStore.snapshot(scope),
    () => imapOverrideStore.snapshot(scope),
  );
}

export function useHelpScoutTriageOverrides(scope: string | null): HelpScoutOverrides {
  return useSyncExternalStore(
    helpScoutOverrideStore.subscribe,
    () => helpScoutOverrideStore.snapshot(scope),
    () => helpScoutOverrideStore.snapshot(scope),
  );
}
