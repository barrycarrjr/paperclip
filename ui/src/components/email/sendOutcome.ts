import type { EmailSendResult } from "../../api/emailTools";

/**
 * The notice for a send that went out, saying out loud anything that did not
 * happen after it.
 *
 * Since email-tools 0.19 a send also saves a copy in the mailbox's Sent folder
 * and marks the message it replied to or forwarded. Either can fail after the
 * mail has already gone. Staying quiet then would recreate the problem the copy
 * exists to solve, a sent message nobody can find afterwards, and calling the
 * send "failed" would invite sending it twice. So the notice leads with what
 * did happen and adds what did not. `warn` asks the caller to show it the way
 * it shows failures, so it is not missed.
 */
export function sendOutcomeText(
  done: string,
  result: EmailSendResult | undefined,
): { text: string; warn: boolean } {
  const problems: string[] = [];
  const copy = result?.sentCopy;
  // A copy still being saved when the send had to answer is on its way, not
  // missing; the plugin log has the rare case where it then fails.
  if (copy && !copy.ok && !copy.pending) {
    problems.push(`no copy was saved in your Sent folder (${copy.error || "no reason given"})`);
  }
  const original = result?.original;
  // Also quiet: a mark still being set, a server that can never keep the flag
  // (a fixed fact, shown once by Test connection rather than on every send),
  // and an original the plugin only went looking for by Message-ID and did not
  // find in the watched folder, which the operator never asked to have marked.
  const quietMiss = original?.notFound && original.uid === undefined;
  if (original && !original.ok && !quietMiss && !original.pending && !original.unsupported) {
    const mark = original.flag === "$Forwarded" ? "forwarded" : "replied";
    problems.push(`the original was not marked ${mark} (${original.error || "no reason given"})`);
  }
  if (problems.length === 0) return { text: done, warn: false };
  return { text: `${done}, but ${problems.join(" and ")}`, warn: true };
}
