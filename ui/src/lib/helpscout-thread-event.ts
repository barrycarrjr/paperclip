import type { HSThread } from "../api/helpScoutBridge";

/**
 * Describe a Help Scout `lineitem` thread — a record of something happening to
 * the conversation (closed, assigned, moved, tagged) rather than a message.
 *
 * Help Scout documents these as having no body at all; the readable summary
 * lives in `action.text` ("You marked as Closed"). We had been rendering every
 * thread as a message card, so a lineitem showed up as an empty white bar.
 *
 * Falls back through `action.type` (an internal slug like
 * `changed-ticket-status`) to a generic label, because a state change with no
 * caption is still worth showing on the timeline.
 */
export function describeThreadEvent(thread: HSThread): string {
  const text = thread.action?.text?.trim();
  if (text) return text;

  const type = thread.action?.type?.trim();
  if (type) return humanizeActionType(type);

  return "Conversation updated";
}

/** `changed-ticket-status` -> `Changed ticket status`. */
function humanizeActionType(type: string): string {
  const words = type.replace(/[-_]+/g, " ").trim();
  if (!words) return "Conversation updated";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** True for threads that record a state change rather than carrying a message. */
export function isThreadEvent(thread: HSThread): boolean {
  return (thread.type ?? "").toLowerCase() === "lineitem";
}
