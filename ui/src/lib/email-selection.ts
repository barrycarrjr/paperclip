/**
 * The rules for ticking several messages in the mail list and acting on them
 * together.
 *
 * Only the rules live here, so they can be read and tested without a browser.
 * The list itself already knows how to act on one message at a time; picking
 * several and running the same action over each of them is the new part, and
 * the fiddly bits are all about when a set of ticks stops being trustworthy.
 *
 * A tick is stored as the message's IMAP uid turned into text, because the
 * shared row-selection helpers work in strings. A uid only means anything
 * inside one folder of one mailbox, which is why so much of this file is about
 * throwing ticks away.
 */

import type { EmailListView } from "./email-list-view";
import type { BulkRunResult } from "./bulk-run";
import { summarizeBulkRun } from "./bulk-run";

/** What you can do to a group of ticked messages. */
export type EmailBulkAction = "read" | "move";

/**
 * Past tense, because these words are used to report what happened
 * afterwards, not to label the button.
 */
export const EMAIL_BULK_ACTION_VERB: Record<EmailBulkAction, string> = {
  read: "Marked read",
  move: "Moved",
};

/** A ticked row is identified by its uid as text. */
export function messageSelectionId(uid: number): string {
  return String(uid);
}

export function selectionIdsToUids(ids: readonly string[]): number[] {
  return ids.map((id) => Number(id)).filter((uid) => Number.isFinite(uid));
}

/**
 * Whether ticking messages is possible at all in the current view.
 *
 * Two places say no. Search results come from any mailbox and any folder, and
 * the actions here are bound to the one mailbox and folder the page has open,
 * so a tick there would act on the wrong message; the list already withholds
 * its per-row buttons from search results for exactly this reason. "With
 * agents" is not the mailbox list at all, it is the list of handovers, so
 * there is nothing there to tick.
 */
export function canSelectMessages(input: {
  view: EmailListView;
  searchActive: boolean;
}): boolean {
  return !input.searchActive && input.view !== "agents";
}

/**
 * What happens to the ticks when the person changes something underneath
 * them.
 *
 * Every one of these clears. The tabs show different sets of messages, so a
 * tick made under "Unread" can point at a row that is not on screen under
 * "All mail"; the mailbox and the folder change what a uid even refers to;
 * and a company switch has to leave nothing of the previous company behind,
 * which is the rule the whole app now follows.
 *
 * Leaving select mode switched on is deliberate for the first three: the
 * person asked for checkboxes and is still in the same mailbox screen, so
 * they get empty checkboxes rather than having to press Select again. A
 * company switch is a bigger move and puts the list back the way it opens.
 */
export type EmailSelectionReset = "keep-mode" | "leave-mode";

/** Everything the ticks depend on being unchanged. */
export interface EmailSelectionContext {
  company: string | null;
  mailbox: string | null;
  folder: string;
  view: EmailListView;
}

export type EmailSelectionChange = "company" | "mailbox" | "folder" | "tab";

/**
 * Which change happened, so the page can say why the ticks went.
 *
 * A company switch usually changes the mailbox as well, so the order matters:
 * the biggest change wins and the reset that goes with it is the strictest.
 * Null means nothing that matters moved and the ticks stand.
 */
export function selectionContextChange(
  prev: EmailSelectionContext,
  next: EmailSelectionContext,
): EmailSelectionChange | null {
  if (prev.company !== next.company) return "company";
  if (prev.mailbox !== next.mailbox) return "mailbox";
  if (prev.folder !== next.folder) return "folder";
  if (prev.view !== next.view) return "tab";
  return null;
}

export function resetForChange(
  change: "tab" | "mailbox" | "folder" | "company",
  nextView?: EmailListView,
): EmailSelectionReset {
  if (change === "company") return "leave-mode";
  // Nothing to tick on the handover list, so the checkboxes would just sit
  // there with nothing to do.
  if (change === "tab" && nextView === "agents") return "leave-mode";
  return "keep-mode";
}

/**
 * One line saying what actually happened, including the half-successes.
 *
 * There is no endpoint that moves or flags a batch of messages, so a run of
 * ten is ten calls and some of them can fail while others work. Reporting
 * that as "Moved" would be a lie, so the count of what worked and the count
 * of what did not are both in the sentence, and the tone stops it being read
 * as a plain success.
 */
export function summarizeEmailBulkRun<T>(
  result: BulkRunResult<T>,
  action: EmailBulkAction,
): { tone: "success" | "warning" | "error"; message: string } {
  return summarizeBulkRun(result, EMAIL_BULK_ACTION_VERB[action], {
    noun: "message",
    plural: "messages",
    slowedBy: "the mail server",
  });
}
