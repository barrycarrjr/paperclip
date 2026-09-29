/**
 * An agent's recorded error, in words a person can act on.
 *
 * The error an agent keeps after a failed run is whatever its provider
 * printed, for example "Claude run failed: subtype=success: Failed to
 * authenticate: OAuth session expired and could not be refreshed". That was
 * shown as it came, twice on the Team page, and the reader was left to work
 * out that it meant "the sign-in ran out" and that the fix lives on the
 * Adapters settings page.
 *
 * Only failures we can recognise with confidence, and that the person can fix
 * from the app, get new words here. Anything else returns null and keeps being
 * shown in its own words, because a guessed explanation is worse than the real
 * text.
 *
 * This reads the text, not a code, on purpose. Failed runs carry a proper
 * error code (see describeRunFailureCause in shared), but the error kept on
 * the agent itself is text only, and that is what the Team page and the
 * agent's own page show.
 */

/** Where the computer's provider sign-ins are fixed. Same page ClaudeSignInScope links to. */
export const ADAPTERS_SETTINGS_PATH = "/instance/settings/adapters";

export interface AgentErrorExplanation {
  /** What went wrong, in one plain sentence. */
  summary: string;
  /**
   * What to do about it. The sentence leads into the fix link, so it reads
   * "... under" followed by the link and a full stop.
   */
  hint: string;
  /** The page where the fix lives. */
  fixLink: { label: string; to: string };
  /** The error as it was recorded, for a Details toggle. */
  raw: string;
}

/**
 * Wording that means the provider refused the agent's sign-in. A 401 only
 * counts as a number on its own (not part of a name like PER-401) and next
 * to a word about signing in or an HTTP status, so an unrelated error that
 * happens to mention a task number is not read as a sign-in failure.
 */
const SIGNED_OUT_PATTERNS: readonly RegExp[] = [
  /oauth session expired/i,
  /failed to authenticate/i,
  /(?<![\w-])401(?![\w-])[^\n]{0,30}\b(unauthori[sz]ed|authenticat\w*|oauth)\b/i,
  /\b(api error|unauthori[sz]ed|status(?: code)?|http)\b[^\n]{0,20}(?<![\w-])401(?![\w-])/i,
];

/**
 * The adapters whose sign-in can be redone on the Adapters page, and the
 * product name to put in the sentence. These are the ones the server gives an
 * authenticate step (server/src/adapters/registry.ts). Any other agent, for
 * example one on Gemini with an API key or one calling a webhook, cannot be
 * fixed there, so its error keeps its own words.
 */
const SIGN_IN_ON_ADAPTERS_PAGE: ReadonlyMap<string, string> = new Map([
  ["claude_local", "Claude"],
  ["codex_local", "Codex"],
]);

export function explainAgentError(
  raw: string | null | undefined,
  adapterType?: string | null,
): AgentErrorExplanation | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return null;

  const product = SIGN_IN_ON_ADAPTERS_PAGE.get(adapterType ?? "");
  if (product && SIGNED_OUT_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      summary: `Its last run could not sign in to ${product}.`,
      hint: "Try again. If it fails again, sign in again under",
      fixLink: { label: "Adapters", to: ADAPTERS_SETTINGS_PATH },
      raw: text,
    };
  }

  return null;
}
