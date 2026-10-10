/**
 * Redacting text out of an issue comment (board only). Shared so the server
 * and the UI's preview replace text the same way.
 *
 * Each target is replaced wherever it appears, exactly as written. By default
 * the replacement keeps the target's last 4 letters or digits, so the comment
 * still says which account it was about: "[redacted …1234]".
 */
import { z } from "zod";

/** Most targets in one redaction. */
export const COMMENT_REDACTION_MAX_TARGETS = 20;

/**
 * Letters, digits, spaces and . # / _ - only. Account numbers and similar fit;
 * quotes and backslashes are refused so a target is the same text inside
 * stored JSON copies of the comment as in the comment itself.
 */
export const COMMENT_REDACTION_TARGET_PATTERN = /^[A-Za-z0-9 .#/_-]+$/;

export const redactIssueCommentSchema = z.object({
  targets: z
    .array(
      z
        .string()
        .transform((s) => s.trim())
        .pipe(
          z
            .string()
            .min(4, "Each text to hide must be at least 4 characters")
            .max(200, "Each text to hide must be at most 200 characters")
            .regex(COMMENT_REDACTION_TARGET_PATTERN, "Only letters, digits, spaces and . # / _ - can be redacted"),
        ),
    )
    .min(1, "Give at least one text to hide")
    .max(COMMENT_REDACTION_MAX_TARGETS),
  keepLast4: z.boolean().default(true),
});

export type RedactIssueComment = z.infer<typeof redactIssueCommentSchema>;

/** What a target becomes. */
export function commentRedactionReplacement(target: string, keepLast4 = true): string {
  const alnum = target.replace(/[^A-Za-z0-9]/g, "");
  return keepLast4 && alnum.length > 4 ? `[redacted …${alnum.slice(-4)}]` : "[redacted]";
}

/**
 * Replace every target in `text`. Longer targets go first, so a target that
 * contains another is replaced whole. Returns the new text and how many
 * replacements were made.
 */
export function applyCommentRedactions(
  text: string,
  targets: readonly string[],
  keepLast4 = true,
): { text: string; replaced: number } {
  let out = text;
  let replaced = 0;
  const ordered = [...new Set(targets.map((t) => t.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const target of ordered) {
    const parts = out.split(target);
    if (parts.length > 1) {
      replaced += parts.length - 1;
      out = parts.join(commentRedactionReplacement(target, keepLast4));
    }
  }
  return { text: out, replaced };
}
