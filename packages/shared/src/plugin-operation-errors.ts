/**
 * Structured failures from plugin operations and tools.
 *
 * A plugin used to report a failure as `error: string` and nothing else. That
 * is fine for a person reading a log and useless to an agent deciding what to
 * do next: "Help Scout returned 401" and "Help Scout returned 503" are the
 * same shape, but one is worth retrying in a minute and the other will never
 * succeed until a human reconnects the account. Agents duly retried the
 * hopeless ones and gave up on the recoverable ones.
 *
 * A failure now carries a code from a fixed list, and the host turns that code
 * into a plain instruction the agent can follow. The prose stays; the code is
 * what gets acted on.
 *
 * @see PLUGIN_SPEC.md §11.6 — Operation failures
 */

import type { PluginOperationErrorCode } from "./constants.js";

/**
 * A failure returned from an operation or tool handler.
 *
 * Carried on `ToolResult.failure`. `ToolResult.error` continues to carry the
 * same human-readable message, so every existing caller keeps working
 * unchanged and only callers that want the code have to know about it.
 */
export interface PluginOperationFailureDetail {
  /** What kind of failure this is. Drives retry and escalation decisions. */
  code: PluginOperationErrorCode;
  /**
   * Human-readable explanation. Written for whoever reads it next — an agent,
   * an operator, or a support log — so name the system and what it said.
   */
  message: string;
  /**
   * How long to wait before retrying, when the failing system said so (a
   * `Retry-After` header, a rate-limit window). Only meaningful for codes
   * that are retryable at all.
   */
  retryAfterMs?: number;
  /**
   * Anything else worth recording: the upstream status code, a request id,
   * the field that failed validation. Not shown to agents verbatim.
   */
  details?: unknown;
}

/** Codes where calling again, unchanged, could plausibly succeed. */
const RETRYABLE_CODES = new Set<PluginOperationErrorCode>([
  "unavailable",
  "timeout",
]);

/**
 * Codes that no amount of retrying gets past, because a person has to do
 * something outside the agent's reach — reconnect an account, grant access.
 */
const NEEDS_PERSON_CODES = new Set<PluginOperationErrorCode>([
  "needs_reconnect",
  "not_authorized",
]);

/**
 * Whether calling again with the same input could succeed.
 *
 * Note that `invalid_input` is NOT retryable in this sense: the caller should
 * call again with *different* input, which is a different decision.
 */
export function isRetryableOperationError(code: PluginOperationErrorCode): boolean {
  return RETRYABLE_CODES.has(code);
}

/** Whether clearing this failure needs a human, not another attempt. */
export function operationErrorNeedsPerson(code: PluginOperationErrorCode): boolean {
  return NEEDS_PERSON_CODES.has(code);
}

/**
 * The instruction appended to a failure message when it reaches an agent.
 *
 * Kept as one short sentence per code, in plain words, because it is read by a
 * model mid-run alongside a lot of other text. The point is that the model can
 * act on it without having to infer anything from the prose above it.
 */
const AGENT_GUIDANCE: Record<PluginOperationErrorCode, string> = {
  invalid_input:
    "The input was rejected. Correct the parameters and call again; the same input will fail the same way.",
  not_found:
    "The thing you named does not exist. Do not call again with the same identifier.",
  not_authorized:
    "You are not allowed to do this. Do not retry. Tell the user, who may be able to grant access.",
  needs_reconnect:
    "The connected account needs to be reconnected by a person before this can work. Do not retry. Tell the user what to reconnect.",
  unavailable:
    "The other system is temporarily unavailable. It is safe to try again later.",
  timeout:
    "It took too long to complete. You may try again, but if this operation writes something, reuse the same idempotency key so it cannot happen twice.",
  failed:
    "It failed for a reason retrying will not fix. Do not call again with the same input; report what happened.",
};

/**
 * Build the text an agent sees for a failure: the plugin's own message, then
 * one sentence saying what to do about it.
 *
 * Falls back to the bare message when there is no structured failure, so a
 * plugin that has not adopted codes reads exactly as it did before.
 */
export function describeOperationFailure(
  failure: PluginOperationFailureDetail | undefined,
  fallbackMessage?: string,
): string {
  if (!failure) return fallbackMessage ?? "The operation failed.";

  const parts = [failure.message.trim() || "The operation failed."];
  parts.push(AGENT_GUIDANCE[failure.code]);

  if (isRetryableOperationError(failure.code) && typeof failure.retryAfterMs === "number") {
    const seconds = Math.max(1, Math.round(failure.retryAfterMs / 1000));
    parts.push(`Wait about ${seconds} second${seconds === 1 ? "" : "s"} first.`);
  }

  return parts.join(" ");
}

/**
 * Recognise a structured failure that arrived over the wire.
 *
 * A plugin worker is a separate process and its output is untrusted shape-wise,
 * so anything that does not carry a known code is treated as absent rather
 * than passed along half-formed.
 */
export function isPluginOperationFailure(
  value: unknown,
  knownCodes: readonly PluginOperationErrorCode[],
): value is PluginOperationFailureDetail {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { code?: unknown; message?: unknown };
  return (
    typeof candidate.code === "string"
    && (knownCodes as readonly string[]).includes(candidate.code)
    && typeof candidate.message === "string"
  );
}
