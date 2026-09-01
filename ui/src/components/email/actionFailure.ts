/**
 * How a failed email action is worded for the operator.
 *
 * Shared because the same failure has to reach three different surfaces: an
 * inline notice under the composer that was being used, a toast on whichever
 * page opened it, and the Email page's own compose dialog. They all used to
 * word it differently or, more often, not at all, and a send that failed in
 * silence reads as a dead button rather than as a rejection.
 */

/** The useful part of a thrown failure, or "" when it carried no text. */
export function failureDetail(err: unknown): string {
  if (err instanceof Error) return err.message.trim();
  if (typeof err === "string") return err.trim();
  return "";
}

/**
 * Toast wording for a failed action. The action name is included because a
 * toast is often the only signal, and "failed" alone does not say what did.
 */
export function actionFailureText(action: string, err: unknown): string {
  const detail = failureDetail(err);
  return detail ? `${action} failed: ${detail}` : `${action} failed`;
}

/** Inline wording, shown right under the control that was pressed. */
export function inlineFailureText(err: unknown): string {
  return failureDetail(err) || "That did not go through. Try again.";
}
