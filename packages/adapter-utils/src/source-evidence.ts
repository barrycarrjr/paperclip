/** Shared guidance for answers whose claims must be checkable against sources. */
export const SOURCE_EVIDENCE_INSTRUCTIONS = [
  "## Source evidence and coverage",
  "",
  "For each claim about money (including prices, amounts and budgets), dates (including deadlines), or legal terms, read the source document and cite its link, document id or path and relevant section beside the claim. Do not state the claim when the source is missing, unread, ambiguous or does not support it. Do not substitute remembered figures or invented citations.",
  "",
  "For answers drawn from company notes or a knowledge base, use only what the notes support. Label any separately supported outside knowledge as Outside knowledge, or leave it out. The same source requirement applies to money, dates and legal terms from outside the notes.",
  "",
  "End each knowledge-base answer with exactly these two coverage lines:",
  "Read: <titles and links or paths of the notes actually opened and read for this answer>",
  "Not covered: <what those notes do not establish, including missing or conflicting evidence; say None identified only within the notes read>",
  "Never list a note as read merely because a search result, filename or memory mentioned it. If no notes were available, say Read: None and describe the missing evidence in Not covered.",
].join("\n");

/** Append once without changing custom text. Companion instructions must be loaded and delivered in this invocation. */
export function appendSourceEvidenceInstructions(prompt: string, deliveredInstructions?: string | null): string {
  if (prompt.includes(SOURCE_EVIDENCE_INSTRUCTIONS) || deliveredInstructions?.includes(SOURCE_EVIDENCE_INSTRUCTIONS)) return prompt;
  return prompt.length > 0 ? `${prompt}\n\n${SOURCE_EVIDENCE_INSTRUCTIONS}` : SOURCE_EVIDENCE_INSTRUCTIONS;
}
