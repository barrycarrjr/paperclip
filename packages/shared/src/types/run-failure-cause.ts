/**
 * What a run's failure code actually means, in words an operator can act on.
 *
 * Adapters write a machine-readable `errorCode` onto a failed run
 * (`claude_auth_required`, `codex_auth_required`, ...) and until now nothing
 * read it except one branch of the run detail page. So the attention queue said
 * "Steward failed 3 times with no retry left" four separate times for what was
 * one expired login, and the run page offered Retry as the obvious thing to do
 * when retrying could not possibly work.
 *
 * Keeping the meaning here, in shared, means the queue, the run page and any
 * later surface all say the same thing about the same code.
 */

export interface RunFailureCause {
  /** The failure this code stands for, in one plain sentence. */
  summarize(agentName: string): string;
  /** What the operator has to do about it. */
  fix: string;
  /**
   * True when the work cannot succeed until the fix is done, so offering Retry
   * as the obvious action just manufactures another identical failure.
   */
  retryCannotWork: boolean;
  /** Whether the fix is something the operator does outside this one run. */
  fixIsElsewhere: boolean;
}

/**
 * Deliberately does not say "this agent". Agents normally share one sign-in per
 * machine, so a signed-out failure is usually several agents' problem at once -
 * and this sentence is rendered on the Brief, where an operator seeing it once
 * per agent needs to understand it is one thing to fix, not several.
 */
const SIGNED_OUT_FIX =
  "Sign in again and save the new token. Every agent sharing that sign-in keeps failing the same way until you do.";

function signedOut(product: string): RunFailureCause {
  return {
    summarize: (agentName) => `${agentName} cannot sign in to ${product}`,
    fix: SIGNED_OUT_FIX,
    retryCannotWork: true,
    fixIsElsewhere: true,
  };
}

const CAUSES: Record<string, RunFailureCause> = {
  claude_auth_required: signedOut("Claude Code"),
  codex_auth_required: signedOut("Codex"),
  gemini_auth_required: signedOut("Gemini"),
  timeout: {
    summarize: (agentName) => `${agentName} ran out of time`,
    fix: "Retrying is reasonable. If it keeps timing out, the work is probably too big for one run.",
    retryCannotWork: false,
    fixIsElsewhere: false,
  },
};

/**
 * The known meaning of a run's error code, or null when there is nothing more
 * to say than "it failed" - which is most codes, and saying nothing is better
 * than inventing advice.
 */
export function describeRunFailureCause(errorCode: string | null | undefined): RunFailureCause | null {
  if (!errorCode) return null;
  return CAUSES[errorCode] ?? null;
}

/**
 * Codes worth collapsing into a single row when one agent hits them over and
 * over. An expired login is one problem however many pieces of work it stalls;
 * a plain crash is not, because two crashes can have two different causes.
 */
export function isSingleCauseFailure(errorCode: string | null | undefined): boolean {
  const cause = describeRunFailureCause(errorCode);
  return cause !== null && cause.retryCannotWork;
}
