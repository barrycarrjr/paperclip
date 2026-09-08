/**
 * What a portfolio directive would do, worked out before anything is sent.
 *
 * A broadcast hands one plain-words instruction to every accessible company's
 * lead agent at once, and each lead then decomposes it and delegates. One
 * press can therefore start work in eight companies. The preview is the step
 * that says, in the same words the Start work planner uses, exactly what that
 * press would do: who receives it, who does not and why, who in each company
 * picks it up, that nothing exists until each lead acts, and whether the
 * agents' outbound emails, messages, calls and public posts will wait for the
 * owner's approval.
 *
 * The facts are all worked out by the server (`portfolioDirectiveService`),
 * never by the browser. The sentences are built here so the screen and
 * Clippy's `preview_directive` tool say the same thing in the same words.
 */

/** One company that would receive the directive, and the agent who gets it. */
export interface DirectivePreviewRecipient {
  companyId: string;
  companyName: string;
  /** Same shape as the Start work planner's `lead`. */
  lead: { id: string; name: string };
}

/** One company that would not receive it, with the reason the service gives. */
export interface DirectivePreviewSkip {
  companyId: string;
  companyName: string;
  reason: string;
}

export interface DirectivePreview {
  /**
   * Ties this exact preview to the send that follows it. The send is refused
   * unless it carries this value and the answer has not changed since, so
   * nobody can be shown one set of companies and send to another.
   */
  previewId: string;
  intent: string;
  title: string;
  willReceive: DirectivePreviewRecipient[];
  skipped: DirectivePreviewSkip[];
  guardrails: { outboundHold: boolean };
  /** The plain-words lines, in order, for the screen and for Clippy. */
  summaryLines: string[];
}

/**
 * The plain-words facts above a directive, in reading order.
 *
 * Every sentence here is either taken word for word from the Start work
 * planner's panel (the approval hold ones) or written in its style, because
 * both panels answer the same question: what happens if I press this.
 */
export function directivePreviewSummaryLines(input: {
  willReceive: { companyName: string }[];
  skipped: { companyName: string }[];
  guardrails: { outboundHold: boolean };
}): string[] {
  const going = input.willReceive.length;
  const left = input.skipped.length;
  const lines: string[] = [];

  if (going === 0) {
    lines.push("No company will receive this, so nothing would be sent.");
  } else {
    lines.push(
      `Goes to ${going} ${going === 1 ? "company" : "companies"}, named below with the lead who receives it.`,
    );
    lines.push(
      "Creates one request in each of them. Nothing else exists until each lead acts on it.",
    );
  }

  if (left > 0) {
    lines.push(
      `${left} ${left === 1 ? "company is" : "companies are"} left out. The reasons are below.`,
    );
  }

  lines.push(
    input.guardrails.outboundHold
      ? "Emails, messages, calls and public posts the agents draft will wait for your approval first."
      : "The approval hold is switched off, so emails, messages, calls and public posts the agents make will go out without asking you. Change this under Instance settings.",
  );

  lines.push("Nothing has been sent yet. Nothing happens until you send it.");
  return lines;
}
