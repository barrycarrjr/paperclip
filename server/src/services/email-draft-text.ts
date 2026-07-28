/**
 * Post-processing for AI-generated email replies.
 *
 * Adapter-routed models (the Claude Code CLI in particular) like to narrate
 * before they answer:
 *
 *   This is an email drafting task with a clear, specific instruction.
 *   Let me write the reply body directly.
 *
 *   Here's the draft reply:
 *
 *   Thanks for the detail, and for sharing the example ...
 *
 * That narration is addressed to the operator, not the customer, and it was
 * landing verbatim in the composer — one Send click away from a customer. The
 * system prompt already forbids it; this is the belt-and-braces pass for models
 * that ignore the instruction anyway.
 */

export interface DraftPromptInput {
  /** "reply" answers an email; "new" writes a first message to someone. */
  mode: "reply" | "new";
  subject?: string;
  from?: string;
  to?: string;
  bodyText?: string;
  instructions?: string;
  currentDraft?: string;
}

/**
 * Build the user turn for a draft request. Kept out of the route so the exact
 * wording — especially the revise-vs-write instruction, which decides whether
 * the operator's existing text survives — is covered by tests.
 */
export function buildDraftUserText(input: DraftPromptInput): string {
  const draft = input.currentDraft?.trim() ?? "";
  const revising = draft.length > 0;
  const noun = input.mode === "reply" ? "reply" : "message";

  const header =
    input.mode === "reply"
      ? [
          "Email I am replying to:",
          input.from ? `From: ${input.from}` : null,
          input.subject ? `Subject: ${input.subject}` : null,
          "",
          (input.bodyText ?? "").slice(0, 30_000) || "(empty body)",
        ]
      : [
          "New email I am writing:",
          input.to ? `To: ${input.to}` : null,
          input.subject ? `Subject: ${input.subject}` : null,
          input.subject ? null : "(no subject yet)",
        ];

  return [
    ...header,
    "",
    revising ? `The ${noun} I have so far:` : null,
    revising ? draft.slice(0, 20_000) : null,
    revising ? "" : null,
    input.instructions?.trim()
      ? `Instructions from the operator: ${input.instructions.trim()}`
      : null,
    "",
    revising
      ? `Rewrite the ${noun} above so it follows the operator's instructions. Keep everything they did not ask you to change. Output the full revised ${noun}, nothing else.`
      : `Write the body of the ${noun} now. Output the ${noun} itself, nothing else.`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/** A short lead-in line that exists only to announce the draft. */
const ANNOUNCEMENT_LINE =
  /^(here('|’)?s?\s+(is\s+)?)?(a|the|my)?\s*(draft(ed)?|suggested|proposed|revised|updated)?\s*(reply|response|draft|email|message)\s*:$/i;

/** Sentence fragments that only make sense as commentary about the task. */
const META_SENTENCE = [
  /\b(email\s+)?drafting\s+task\b/i,
  /\bthis\s+is\s+an?\s+email\b/i,
  // "Let me write the reply body directly." The verb has to act on the reply
  // itself — otherwise a genuine "I'll write up the full spec tomorrow" reads
  // as preamble and gets deleted.
  /\b(write|writing|draft|drafting|compose|composing|put(ting)?\s+together)\s+(the|a|my)\s+(reply|response|email|message)(\s+body)?\b/i,
  /\bthe\s+reply\s+body\b/i,
  /\bhere('|’)?s?\s+(is\s+)?(a|the|my)\s+(draft|revised|updated|suggested)\b/i,
  /\b(based\s+on|per|following)\s+(your|the)\s+instruction/i,
  // Bare acknowledgements only — "Of course we can help with that" is a reply.
  /^(sure|certainly|of\s+course|got\s+it|understood|no\s+problem)\b\s*[,.!]?$/i,
];

/** Split a block into rough sentences — good enough for a heuristic. */
function sentences(block: string): string[] {
  return block
    .split(/(?<=[.!?:])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isPreambleBlock(block: string): boolean {
  const trimmed = block.trim();
  if (!trimmed) return false;

  // "Here's the draft reply:" and friends — a short colon-terminated lead-in.
  if (trimmed.length <= 120 && ANNOUNCEMENT_LINE.test(trimmed)) return true;

  // Otherwise every sentence in the block has to read as commentary about the
  // task. One ordinary sentence and we keep the whole block — a false negative
  // just leaves a stray line the operator can delete, whereas a false positive
  // silently eats real reply content.
  if (trimmed.length > 400) return false;
  const parts = sentences(trimmed);
  if (parts.length === 0) return false;
  return parts.every((s) => META_SENTENCE.some((re) => re.test(s)));
}

/**
 * Strip leading model commentary from a draft, leaving only the reply body.
 * Never returns empty: if every block looks like preamble we assume the
 * heuristic is wrong and hand back the original text.
 */
export function stripDraftPreamble(raw: string): string {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) return "";

  // Some models wrap the whole reply in a fence. Unwrap before splitting so a
  // preamble inside the fence is still reachable.
  const fenced = /^```[a-z]*\n([\s\S]*?)\n?```$/i.exec(text);
  const body = fenced ? fenced[1].trim() : text;

  const blocks = body.split(/\n\s*\n/);
  let i = 0;
  // Stop at the last block so we can never strip everything.
  while (i < blocks.length - 1 && isPreambleBlock(blocks[i])) i++;

  const result = blocks.slice(i).join("\n\n").trim();
  return result || text;
}
