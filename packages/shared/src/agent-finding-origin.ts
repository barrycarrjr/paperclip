/**
 * Durable identity for a finding an agent reports as an issue.
 *
 * Agents that watch something on a schedule (Steward's daily sweep was the
 * first) used to file the same warning again every time they saw it: nothing
 * let an agent say "this is the finding I reported before", and the dedupe
 * fields its instructions told it to send were not part of the create
 * contract, so they were dropped. One instance ended up with 82 open issues
 * from one agent, almost all repeats.
 *
 * Now the agent tags the issue with its own stable key for the finding (a
 * detector fingerprint, for example). The key is stored in the issue's
 * existing `originKind`/`originId` columns, and the server refuses a second
 * issue from the same reporter with the same key in the same company,
 * whatever the first one's status or whether it was hidden: a cancelled or
 * hidden finding was dismissed, and a done one gets a comment if the problem
 * comes back.
 *
 * Not added to `ISSUE_ORIGIN_KINDS`, following the `email_handoff` pattern of
 * a feature-local kind.
 */
export const AGENT_FINDING_ORIGIN_KIND = "agent_finding";

/** Same bound as every other client-declared origin id. */
export const AGENT_FINDING_KEY_MAX_LENGTH = 500;

export function isAgentFindingOriginKind(originKind: string | null | undefined): boolean {
  return originKind === AGENT_FINDING_ORIGIN_KIND;
}
