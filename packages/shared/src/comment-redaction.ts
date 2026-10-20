/** Manual, exact replacement shared by the board preview and server. */
import { z } from "zod";
import type { IssueComment } from "./types/issue.js";

export const COMMENT_REDACTION_MAX_TARGETS = 20;
export const COMMENT_REDACTION_MIN_TARGET_LENGTH = 4;
// Express limits the complete encoded JSON request to 30 MiB as well.
export const COMMENT_REDACTION_MAX_BODY_BYTES = 30 * 1024 * 1024;
export const COMMENT_REDACTION_BODY_SIZE_ERROR = "The comment text exceeds the 30 MiB UTF-8 limit. The complete JSON request must also fit within 30 MiB.";
export const redactIssueCommentSchema = z.object({
  targets: z.array(z.string().min(COMMENT_REDACTION_MIN_TARGET_LENGTH, "Select at least 4 characters; include surrounding text for shorter secrets.").max(2000)
    .refine((s) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s), "Select valid Unicode characters.")
    .refine((s) => Array.from(s.trim()).length >= COMMENT_REDACTION_MIN_TARGET_LENGTH, "Select at least 4 non-padding characters."))
    .min(1).max(COMMENT_REDACTION_MAX_TARGETS),
  keepLast4: z.boolean().default(true),
  // The exact version the board previewed, never persisted in an authorization.
  expectedBody: z.string().min(1)
    .max(COMMENT_REDACTION_MAX_BODY_BYTES, COMMENT_REDACTION_BODY_SIZE_ERROR)
    .refine((body) => body.length <= COMMENT_REDACTION_MAX_BODY_BYTES && new TextEncoder().encode(body).byteLength <= COMMENT_REDACTION_MAX_BODY_BYTES, COMMENT_REDACTION_BODY_SIZE_ERROR),
  impactToken: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export const authorizeCommentRedactionSchema = redactIssueCommentSchema.extend({ agentId: z.string().uuid() });
export const executeCommentRedactionSchema = z.object({ authorizationId: z.string().uuid() }).strict();
export type RedactIssueComment = z.infer<typeof redactIssueCommentSchema>;
export type AuthorizeCommentRedaction = z.infer<typeof authorizeCommentRedactionSchema>;

export function commentRedactionRanges(text: string, targets: readonly string[]) {
  const ordered = [...new Set(targets)].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!ordered.length) return [];
  const pattern = new RegExp(ordered.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  return [...text.matchAll(pattern)].map((m) => ({ start: m.index!, length: m[0].length }));
}

/** Public counts. Chat categories cover only the board requester's own sessions. */
export interface CommentRedactionCounts {
  comment: number;
  activityLog: number;
  runContexts: number;
  runExcerpts: number;
  runEvents: number;
  wakeupRequests: number;
  reviewDecisions: number;
  chatMessages: number;
  chatSessions: number;
  runtimeState: number;
  taskSessions: number;
  threadInteractions: number;
  runLogFiles: number;
}
export interface CommentRedactionImpact {
  counts: CommentRedactionCounts;
  impactToken: string;
  estimated: true;
  oversizedFields: number;
  /** Visible JSON fields skipped because their nesting exceeds the safe limit. */
  skippedFields: number;
  /** Remaining exact/encoded matches and possible cut-off pieces in visible covered fields, including preserved values. */
  residualMatches: number;
  /** False when the separate bounded visible cut-off scan could not finish. */
  cutoffCheckComplete: boolean;
}
export interface CommentRedactionResponse {
  comment: IssueComment;
  replaced: number;
  placesChanged: CommentRedactionCounts;
  otherCommentsWithText: number;
  notReachable: string[];
  fileCleanup: "complete" | "incomplete";
  auditFinalized: boolean;
  activeRunCount: number | null;
  /** New actions always report incomplete to avoid disclosing private chat outcomes. */
  cleanupStatus: "complete" | "incomplete";
  residualMatches: number;
  /** False when the separate bounded visible cut-off scan could not finish. */
  cutoffCheckComplete: boolean;
  oversizedFields: number;
  skippedFields: number;
}
export interface CommentRedactionAuthorizationResponse {
  authorizationId: string;
  instructionComment: IssueComment;
  expiresAt: string;
}

export function commentRedactionReplacement(target: string, keepLast4 = true): string {
  const alnum = Array.from(target).filter((c) => /[\p{L}\p{N}]/u.test(c));
  return keepLast4 && alnum.length > 8 ? `[redacted …${alnum.slice(-4).join("")}]` : "[redacted]";
}

/** One pass: replacements cannot match later targets or inflate the count. */
export function applyCommentRedactions(text: string, targets: readonly string[], keepLast4 = true) {
  const ordered = [...new Set(targets)].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!ordered.length) return { text, replaced: 0 };
  const pattern = new RegExp(ordered.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  let replaced = 0;
  const next = text.replace(pattern, (match) => {
    replaced++;
    return commentRedactionReplacement(match, keepLast4);
  });
  return { text: next, replaced };
}
