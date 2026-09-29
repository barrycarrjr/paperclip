/**
 * The one line at the top of the Overview and the Portfolio Brief that says
 * whether anything is wrong, and the colour of the dot beside it.
 *
 * Both pages used to decide this on their own, from agent errors (and budget
 * incidents) only. So a company with nine blocked tasks and forty rows waiting
 * in Attention was headed "All systems green.", and the Overview's dot was
 * green even when the words beside it named an agent error. The rule now lives
 * here: "All systems green." only when every count is zero, otherwise the
 * line says what is wrong, worst first.
 */
export type BriefHealthTone = "red" | "amber" | "green";

export type BriefHealthPartKind =
  | "agentErrors"
  | "budgetIncidents"
  | "blockedTasks"
  | "waitingOnYou"
  | "pendingApprovals";

export interface BriefHealthCounts {
  /** Agents whose status is error. */
  agentErrors: number;
  /**
   * Open budget incidents. Most are warnings (spend passed the warn percent)
   * and have paused nothing, so the line calls them incidents, the word the
   * Overview's budget banner uses, and never says a limit was hit.
   */
  budgetIncidents: number;
  blockedTasks: number;
  /** Open rows in the attention queue, the same number the Attention badge shows. */
  waitingOnYou: number;
  /**
   * The summary's `pendingApprovals`, which already counts every pending
   * approval, budget overrides included. Do not add `budgets.pendingApprovals`
   * to it, or each budget override is counted twice.
   */
  pendingApprovals: number;
}

/** An agent in error, named in the health line with a link to its page. */
export interface BriefErroredAgent {
  id: string;
  name: string;
  href: string;
  /** Hover text, such as which company the agent belongs to. */
  title?: string;
}

export interface BriefHealthPart {
  kind: BriefHealthPartKind;
  count: number;
  text: string;
}

export interface BriefHealth {
  tone: BriefHealthTone;
  /** What is wrong, worst first. Empty when all is well. */
  parts: BriefHealthPart[];
  /** The whole line as plain text, ending in a full stop. */
  headline: string;
}

export const ALL_CLEAR_HEADLINE = "All systems green.";

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function briefHealth(counts: BriefHealthCounts): BriefHealth {
  const parts: BriefHealthPart[] = [];
  const add = (kind: BriefHealthPartKind, count: number, text: string) => {
    if (count > 0) parts.push({ kind, count, text });
  };

  add("agentErrors", counts.agentErrors, plural(counts.agentErrors, "agent in error", "agents in error"));
  add(
    "budgetIncidents",
    counts.budgetIncidents,
    plural(counts.budgetIncidents, "budget incident", "budget incidents"),
  );
  add("blockedTasks", counts.blockedTasks, plural(counts.blockedTasks, "task blocked", "tasks blocked"));
  add("waitingOnYou", counts.waitingOnYou, `${counts.waitingOnYou} waiting on you`);
  // A pending approval the operator can decide is already one of the rows
  // waiting on them, so it is only named on its own when the queue is empty,
  // or the same approval would be counted twice in one line.
  if (counts.waitingOnYou <= 0) {
    add(
      "pendingApprovals",
      counts.pendingApprovals,
      plural(counts.pendingApprovals, "approval pending", "approvals pending"),
    );
  }

  // Budget incidents are amber, not red: most are the warn-percent warning and
  // have paused nothing, and the summary has no count of real stops to tell
  // the two apart. A real stop still shows, as the budget override approval it
  // creates.
  const tone: BriefHealthTone =
    counts.agentErrors > 0
      ? "red"
      : parts.length > 0
        ? "amber"
        : "green";

  return {
    tone,
    parts,
    headline: parts.length === 0 ? ALL_CLEAR_HEADLINE : `${parts.map((p) => p.text).join(", ")}.`,
  };
}
