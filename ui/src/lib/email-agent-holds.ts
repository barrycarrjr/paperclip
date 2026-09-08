import {
  buildEmailHandoffOriginId,
  type EmailDelegationState,
} from "@paperclipai/shared";
import type { EmailHandoffSummary, TakeOverHandoffResult } from "@/api/emailHandoffs";

/**
 * Matching a message in the mail list to the agent holding it.
 *
 * The mail list reads a mailbox. This app's records live in its own database.
 * Nothing joins the two except the source key an email handoff writes down at
 * the moment it happens (`buildEmailHandoffOriginId`), so the list rebuilds
 * that same key for each message it shows and looks for it.
 *
 * Two keys are tried per message, not one. The key builder prefers the
 * message's own Message-Id and only falls back to mailbox, folder and number
 * when there isn't one, so a message that has a Message-Id now could still
 * have been handed over under the fallback form (by an older handoff, or by a
 * provider that did not report the header at the time). Trying both costs one
 * extra lookup in a map and avoids a message quietly looking free when it is
 * not.
 *
 * Everything here is pure so it can be tested without a mailbox, a database
 * or a browser.
 */

/** The parts of a mail row this matching needs. */
export interface MailRowSource {
  uid: number;
  messageId: string | null;
}

export interface MailRowLocation {
  pluginId: string | null;
  mailbox: string | null;
  folder: string | null;
}

/**
 * How the stage of a handover reads on screen.
 *
 * Kept in one place because the mail list, the message itself and the work
 * item's own panel all show it, and three copies of these words is how they
 * end up disagreeing.
 */
export const EMAIL_HOLD_STAGE_LABEL: Record<EmailDelegationState, string> = {
  delegated: "Waiting to be picked up",
  acknowledged: "Picked up",
  in_progress: "Being worked on",
  needs_review: "Waiting on review",
  resolved: "Finished",
  handed_back: "Handed back",
  re_delegated: "Passed to someone else",
};

export function holdStageLabel(status: string): string {
  return EMAIL_HOLD_STAGE_LABEL[status as EmailDelegationState] ?? "Stage not known";
}

/** What to call the agent holding a message when the record has no name. */
export function holderName(hold: Pick<EmailHandoffSummary, "agent">): string {
  const name = hold.agent?.name?.trim();
  if (name) return name;
  if (hold.agent?.id) return "An agent that has since been removed";
  return "An agent we can no longer name";
}

/**
 * Every source key a message could have been handed over under.
 *
 * Returns an empty list when the message cannot be keyed at all, which is the
 * same condition under which a handoff records no source key: with nothing
 * stable to key on there is nothing to match, and guessing would be worse
 * than saying nothing.
 */
export function holdKeysForMessage(
  location: MailRowLocation,
  message: MailRowSource,
): string[] {
  const { pluginId, mailbox, folder } = location;
  if (!pluginId || !mailbox) return [];

  const keys: string[] = [];
  const byMessageId = buildEmailHandoffOriginId({
    pluginId,
    mailbox,
    messageId: message.messageId,
  });
  if (byMessageId) keys.push(byMessageId);

  const byUid = buildEmailHandoffOriginId({
    pluginId,
    mailbox,
    messageId: null,
    folder,
    uid: message.uid,
  });
  if (byUid) keys.push(byUid);

  return keys;
}

/** Index the open handovers by their source key, for a per-row lookup. */
export function indexHoldsBySource(
  holds: readonly EmailHandoffSummary[],
): Map<string, EmailHandoffSummary> {
  const index = new Map<string, EmailHandoffSummary>();
  for (const hold of holds) {
    // First one wins. There can only be one open handover per source key at
    // a time (the database enforces it), so a second is history arriving out
    // of order, and the newest is what the list should show.
    if (!index.has(hold.sourceKey)) index.set(hold.sourceKey, hold);
  }
  return index;
}

/** The agent holding this message, or null when nobody is. */
export function findHoldForMessage(
  index: Map<string, EmailHandoffSummary>,
  location: MailRowLocation,
  message: MailRowSource,
): EmailHandoffSummary | null {
  for (const key of holdKeysForMessage(location, message)) {
    const hold = index.get(key);
    if (hold) return hold;
  }
  return null;
}

/**
 * Where the message a handover names actually lives, in words.
 *
 * Used by the "With agents" list, which shows handovers rather than mail, so
 * each line has to say which mailbox and folder it came from.
 */
export function holdSourceLine(hold: EmailHandoffSummary): string {
  return hold.folder ? `${hold.mailbox} / ${hold.folder}` : hold.mailbox;
}

/**
 * What a person is told after taking a message back.
 *
 * The message ends up outliving the row it came from: as soon as the take
 * over lands, the message stops being held and its panel goes away. So the
 * wording is built here, kept by the page, and shown until it is dismissed.
 *
 * A part that failed is never rounded up into "done". Being told an agent
 * stopped when it did not is the one outcome that could cause real harm,
 * because the person would go back to the message believing nothing else is
 * touching it.
 */
export interface TakeOverOutcomeMessage {
  tone: "ok" | "warning";
  headline: string;
  details: string[];
}

export function takeOverOutcomeMessage(
  result: TakeOverHandoffResult,
  agentName: string,
): TakeOverOutcomeMessage {
  const details: string[] = [];
  let tone: TakeOverOutcomeMessage["tone"] = "ok";

  if (result.run.state === "failed") {
    tone = "warning";
    details.push(
      `${agentName} may still be working: its run could not be stopped. ${result.run.error} Check the agent before you reply.`,
    );
  } else if (result.run.state === "stopped") {
    details.push(`${agentName} has been stopped.`);
  } else {
    details.push(`${agentName} had nothing running, so there was nothing to stop.`);
  }

  if (result.workItem.state === "failed") {
    tone = "warning";
    details.push(
      `The work item could not be updated, so ${agentName} may still be assigned to it. ${result.workItem.error ?? ""}`.trim(),
    );
  } else if (result.workItem.unassignedAgent || result.workItem.statusChangedTo) {
    const parts: string[] = [];
    if (result.workItem.unassignedAgent) parts.push(`${agentName} has been taken off the work item`);
    if (result.workItem.statusChangedTo === "todo") parts.push("it is back on the to-do list");
    details.push(`${parts.join(", and ")}.`);
  } else {
    details.push("The work item was left as it was.");
  }

  details.push("Nothing was sent to whoever emailed you.");

  return {
    tone,
    headline:
      tone === "warning"
        ? "You have the message back, but not everything worked"
        : "You have the message back",
    details,
  };
}
