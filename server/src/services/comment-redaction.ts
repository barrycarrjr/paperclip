/**
 * Board-only redaction of text (for example a full account number) out of an
 * issue comment, and out of the copies Paperclip keeps of comment text
 * elsewhere, so the hidden text does not survive anywhere Paperclip controls.
 *
 * Copies cleaned, all within the comment's company, exact text only:
 *   - the comment itself;
 *   - activity log details (each comment's first 120 characters);
 *   - agent run records: the context snapshot an agent was woken with, the
 *     run's saved output excerpts, run events (the full prompt an adapter was
 *     given), and wake-up request payloads (child-task summaries);
 *   - review decisions copied from a comment;
 *   - board chat messages;
 *   - run log files on disk.
 *
 * Not reachable from here, and reported as such: database backups made
 * before the redaction, agent tools' own session files, and anything a
 * plugin copied into its own storage.
 */
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentWakeupRequests,
  chatMessages,
  chatSessions,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
} from "@paperclipai/db";
import { applyCommentRedactions, commentRedactionReplacement } from "@paperclipai/shared";

export interface CommentRedactionCounts {
  comment: number;
  activityLog: number;
  runContexts: number;
  runExcerpts: number;
  runEvents: number;
  wakeupRequests: number;
  reviewDecisions: number;
  chatMessages: number;
  runLogFiles: number;
}

export interface CommentRedactionResult {
  comment: typeof issueComments.$inferSelect;
  replaced: number;
  counts: CommentRedactionCounts;
  /** Other comments in the company that still contain one of the targets. */
  otherCommentsWithText: number;
  notReachable: string[];
}

export const COMMENT_REDACTION_NOT_REACHABLE = [
  "database backups made before this redaction",
  "agent tools' own session files (outside Paperclip)",
  "copies a plugin keeps in its own storage",
];

/** Does `file` contain `needle`? Read in chunks; the overlap keeps a match split across chunks. */
async function fileContains(file: string, needles: string[]): Promise<boolean> {
  const longest = Math.max(...needles.map((n) => n.length));
  return new Promise((resolve, reject) => {
    let tail = "";
    let found = false;
    const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 });
    stream.on("data", (chunk) => {
      const text = tail + chunk;
      if (needles.some((n) => text.includes(n))) {
        found = true;
        stream.destroy();
        resolve(true);
        return;
      }
      tail = text.slice(-longest);
    });
    stream.on("error", (err) => (found ? undefined : reject(err)));
    stream.on("close", () => {
      if (!found) resolve(false);
    });
  });
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && e.name.endsWith(".ndjson")) yield p;
  }
}

/**
 * Rewrite the company's run log files that contain a target. Each file is
 * rewritten to a temporary file beside it and then moved over the original.
 */
async function redactRunLogFiles(baseDir: string, companyId: string, targets: string[], keepLast4: boolean): Promise<number> {
  const companyDir = path.resolve(baseDir, companyId);
  if (!companyDir.startsWith(path.resolve(baseDir) + path.sep)) return 0;
  let changed = 0;
  for await (const file of walk(companyDir)) {
    if (!(await fileContains(file, targets))) continue;
    const text = await fs.readFile(file, "utf8");
    const { text: next, replaced } = applyCommentRedactions(text, targets, keepLast4);
    if (!replaced) continue;
    const tmp = `${file}.redact-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, next, "utf8");
    await fs.rename(tmp, file);
    changed++;
  }
  return changed;
}

/**
 * Redact `targets` from comment `commentId` and from every stored copy in its
 * company. The caller has already checked board access and that the comment
 * belongs to the issue and company.
 */
export async function redactIssueCommentEverywhere(
  db: Db,
  input: {
    companyId: string;
    commentId: string;
    targets: string[];
    keepLast4: boolean;
    /** Where run logs live; null skips the files (tests, or a non-file store). */
    runLogBaseDir: string | null;
  },
): Promise<CommentRedactionResult | null> {
  const { companyId, commentId, targets, keepLast4 } = input;
  const pairs = [...new Set(targets)]
    .sort((a, b) => b.length - a.length)
    .map((t) => ({ target: t, replacement: commentRedactionReplacement(t, keepLast4) }));

  // Text and JSON columns: replace the exact text wherever it appears in this company.
  const replaceText = (column: ReturnType<typeof sql.raw> | unknown) => {
    let expr = sql`${column}`;
    for (const p of pairs) expr = sql`replace(${expr}, ${p.target}, ${p.replacement})`;
    return expr;
  };
  const replaceJson = (column: unknown) => {
    let expr = sql`(${column})::text`;
    for (const p of pairs) expr = sql`replace(${expr}, ${p.target}, ${p.replacement})`;
    return sql`(${expr})::jsonb`;
  };
  const contains = (column: unknown, json: boolean) => {
    const parts = pairs.map((p) => sql`strpos(${json ? sql`(${column})::text` : sql`${column}`}, ${p.target}) > 0`);
    return sql`(${sql.join(parts, sql` or `)})`;
  };

  const result = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(issueComments)
      .where(and(eq(issueComments.id, commentId), eq(issueComments.companyId, companyId)));
    if (!current) return null;
    const { text: body, replaced } = applyCommentRedactions(current.body, targets, keepLast4);
    if (!replaced) return { comment: current, replaced: 0, counts: null };

    const [comment] = await tx
      .update(issueComments)
      .set({ body, updatedAt: new Date() })
      .where(eq(issueComments.id, commentId))
      .returning();

    const n = (rows: unknown[]) => rows.length;
    const counts: CommentRedactionCounts = {
      comment: 1,
      activityLog: n(
        await tx
          .update(activityLog)
          .set({ details: replaceJson(activityLog.details) as never })
          .where(and(eq(activityLog.companyId, companyId), contains(activityLog.details, true)))
          .returning({ id: activityLog.id }),
      ),
      runContexts: n(
        await tx
          .update(heartbeatRuns)
          .set({ contextSnapshot: replaceJson(heartbeatRuns.contextSnapshot) as never })
          .where(and(eq(heartbeatRuns.companyId, companyId), contains(heartbeatRuns.contextSnapshot, true)))
          .returning({ id: heartbeatRuns.id }),
      ),
      runExcerpts: n(
        await tx
          .update(heartbeatRuns)
          .set({
            stdoutExcerpt: replaceText(heartbeatRuns.stdoutExcerpt) as never,
            stderrExcerpt: replaceText(heartbeatRuns.stderrExcerpt) as never,
          })
          .where(
            and(
              eq(heartbeatRuns.companyId, companyId),
              sql`(${contains(heartbeatRuns.stdoutExcerpt, false)} or ${contains(heartbeatRuns.stderrExcerpt, false)})`,
            ),
          )
          .returning({ id: heartbeatRuns.id }),
      ),
      runEvents: n(
        await tx
          .update(heartbeatRunEvents)
          .set({ payload: replaceJson(heartbeatRunEvents.payload) as never })
          .where(and(eq(heartbeatRunEvents.companyId, companyId), contains(heartbeatRunEvents.payload, true)))
          .returning({ id: heartbeatRunEvents.id }),
      ),
      wakeupRequests: n(
        await tx
          .update(agentWakeupRequests)
          .set({ payload: replaceJson(agentWakeupRequests.payload) as never })
          .where(and(eq(agentWakeupRequests.companyId, companyId), contains(agentWakeupRequests.payload, true)))
          .returning({ id: agentWakeupRequests.id }),
      ),
      reviewDecisions: n(
        await tx
          .update(issueExecutionDecisions)
          .set({ body: replaceText(issueExecutionDecisions.body) as never })
          .where(and(eq(issueExecutionDecisions.companyId, companyId), contains(issueExecutionDecisions.body, false)))
          .returning({ id: issueExecutionDecisions.id }),
      ),
      chatMessages: n(
        await tx
          .update(chatMessages)
          .set({ content: replaceJson(chatMessages.content) as never })
          .where(
            and(
              sql`${chatMessages.sessionId} in (select ${chatSessions.id} from ${chatSessions} where ${chatSessions.companyId} = ${companyId})`,
              contains(chatMessages.content, true),
            ),
          )
          .returning({ id: chatMessages.id }),
      ),
      runLogFiles: 0,
    };
    return { comment: comment!, replaced, counts };
  });

  if (!result) return null;
  if (!result.counts) {
    return {
      comment: result.comment,
      replaced: 0,
      counts: { comment: 0, activityLog: 0, runContexts: 0, runExcerpts: 0, runEvents: 0, wakeupRequests: 0, reviewDecisions: 0, chatMessages: 0, runLogFiles: 0 },
      otherCommentsWithText: 0,
      notReachable: COMMENT_REDACTION_NOT_REACHABLE,
    };
  }

  // Files after the database: a failure here leaves the database redacted and is reported.
  if (input.runLogBaseDir) {
    result.counts.runLogFiles = await redactRunLogFiles(input.runLogBaseDir, companyId, pairs.map((p) => p.target), keepLast4);
  }

  const [{ count: others }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(issueComments)
    .where(and(eq(issueComments.companyId, companyId), contains(issueComments.body, false)));

  return {
    comment: result.comment,
    replaced: result.replaced,
    counts: result.counts,
    otherCommentsWithText: others ?? 0,
    notReachable: COMMENT_REDACTION_NOT_REACHABLE,
  };
}
