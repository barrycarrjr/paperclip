/**
 * Manual redaction, based on feat/redact-comment. All replacements are exact,
 * company-scoped and point-in-time. No rules are installed on future writes.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { and, eq, inArray, isNull, notInArray, sql, getTableColumns, desc, isNotNull, or, gte, type SQL } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import {
  activityLog, agents, agentWakeupRequests, agentRuntimeState, agentTaskSessions,
  chatMessages, chatSessions, commentRedactionAuthorizations,
  heartbeatRunEvents, heartbeatRuns, issueComments, issueExecutionDecisions, issueThreadInteractions,
} from "@paperclipai/db";
import {
  applyCommentRedactions, commentRedactionRanges,
  type AuthorizeCommentRedaction, type RedactIssueComment, type CommentRedactionCounts,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { persistActivityLog, publishPersistedActivityLog, type LogActivityInput, type PersistedActivityLogInput } from "./activity-log.js";
import { withRunLogFileLock } from "./run-log-lock.js";
import { boardActorForLinkedUser } from "../middleware/auth.js";
import { assertActorCompanyAccess } from "../routes/authz.js";
import { instanceSettingsService } from "./instance-settings.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { redactOperationalJson, redactOperationalText, prepareCommentRedaction, logContentEdits, redactionResidualMatches, quotedJsonTokens, type PreparedCommentRedaction, OperationalJsonLimitError, type CommentCopySource } from "./comment-redaction-text.js";

export const COMMENT_REDACTION_NOT_REACHABLE = [
  "database backups made before this redaction (including database recovery history)",
  "agent tools' own session files and provider copies outside Paperclip",
  "copies a plugin keeps in its own storage",
  "other issue comments, documents, attachments, exports and server diagnostic logs",
  "text copied into memory by active runs or chats, and future writes",
  "HQ agents copies in their own company runs, issue titles and descriptions",
  "approval payloads and comments, memories, work product summaries and rule proposals",
  "structural JSON keys and values, configuration, ids and session folders (remaining matches report incomplete)",
  "other users private chats receive bounded best-effort cleanup; their coverage and outcomes are never disclosed",
];
const digest = (body: string) => createHash("sha256").update(body).digest("hex");
const zeroCounts = (): CommentRedactionCounts => ({
  comment: 0, activityLog: 0, runContexts: 0, runExcerpts: 0, runEvents: 0,
  wakeupRequests: 0, reviewDecisions: 0, chatMessages: 0, chatSessions: 0,
  runtimeState: 0, taskSessions: 0, threadInteractions: 0, runLogFiles: 0,
});

type Scope = { companyId: string; issueId: string; commentId: string };
type RedactionActor = Pick<LogActivityInput, "actorType" | "actorId" | "agentId" | "runId">;

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

const MAX_TEXT_BYTES = 256 * 1024;
const BATCH_SIZE = 16;
const MAX_CANDIDATE_ROWS = 5000;
type Category = keyof CommentRedactionCounts;
type CopyField = { name: string; json?: boolean; category: Category };
type CutoffObservation = { table: AnyPgTable; scope: SQL; fields: CopyField[]; candidate: SQL; edgeCandidate: SQL; pk: ReturnType<typeof getTableColumns>[string]; projection: Record<string, SQL>; ids: string[] };

function unicodeCandidate(column: SQL, patterns: PreparedCommentRedaction["unicodeCandidatePatterns"], prechecks: readonly string[]) {
  // Parameters contain regex metacharacters escaped by the prepared matcher.
  // CASE avoids the full programs for unrelated escapes such as colour codes
  // and JSON-escaped Windows paths, as well as ordinary unescaped history.
  return patterns.length ? sql`case when ${or(...prechecks.map((pattern) => sql`${column} ~ ${pattern}`))} then ${or(...patterns.map((parts) => and(...parts.map((pattern) => sql`${column} ~ ${pattern}`))))} else false end` : undefined;
}

/** OFFSET 0 prevents projection pull-up: each covered value is converted to
 * text once per row, then reused by every literal, identity and regex check.
 * Only bounded ids leave PostgreSQL; historical contents are never accumulated. */
async function discoverCopyIds(tx: Transaction, observation: Omit<CutoffObservation, "ids">, condition: SQL, limit: number, excludedIds: string[] = []) {
  const { table, scope, fields, pk } = observation;
  const columns = getTableColumns(table);
  // A no-op text cast can leave a TOAST pointer compressed. Concatenating the
  // empty string detoasts text once; jsonb::text already produces fresh text.
  const values = fields.map((field, index) => sql`${field.json ? sql`${columns[field.name]!}::text`
    : sql`${columns[field.name]!}::text || ''`} as ${sql.identifier(`text${index}`)}`);
  return tx.execute<{ id: string }>(sql`select "copyId"::text as id from (
    select ${pk} as "copyId", ${sql.join(values, sql`, `)} from ${table}
    where ${and(scope, excludedIds.length ? notInArray(pk, excludedIds) : undefined)} offset 0
  ) as "redaction_text" where ${condition} order by "copyId" limit ${limit}`);
}

/** Read-only, bounded observation. One candidate-id scan per table, then small
 * primary-key loads, so a selective planner cannot rescan history every batch. */
async function observeCutoffCopies(tx: Transaction, observations: CutoffObservation[], prepared: PreparedCommentRedaction) {
  const deadline = Date.now() + 30_000;
  let observed = 0;
  let residualMatches = 0;
  let cutoffCheckComplete = true;
  try {
    // A savepoint lets preview retain its exact impact after a timed-out check.
    await tx.transaction(async (reader) => {
      for (const observation of observations) {
        const { table, scope, fields, candidate, edgeCandidate, pk, projection, ids } = observation;
        if (!cutoffCheckComplete) break;
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) { cutoffCheckComplete = false; break; }
        await reader.execute(sql`select set_config('statement_timeout', ${String(Math.min(15_000, remainingMs))}, true)`);
        // Materialize ids only, never full historical values. No row locks here.
        // Check cheap edge conditions first. Rechecking full spellings on every
        // unrelated history row would duplicate the main discovery's work.
        const matching = await discoverCopyIds(reader, observation,
          sql`case when ${edgeCandidate} then (${candidate}) is not true else false end`, MAX_CANDIDATE_ROWS - observed + 1, ids);
        if (matching.length > MAX_CANDIDATE_ROWS - observed) cutoffCheckComplete = false;
        const bounded = matching.slice(0, MAX_CANDIDATE_ROWS - observed);
        for (let offset = 0; offset < bounded.length; offset += BATCH_SIZE) {
          const batchMs = deadline - Date.now();
          if (batchMs <= 0) { cutoffCheckComplete = false; break; }
          await reader.execute(sql`select set_config('statement_timeout', ${String(Math.min(15_000, batchMs))}, true)`);
          // Reapply company/ownership scope if rows changed after id discovery.
          const rows = await reader.select(projection).from(table)
            .where(and(scope, inArray(pk, bounded.slice(offset, offset + BATCH_SIZE).map((row) => row.id))));
          observed += rows.length;
          for (const row of rows) for (const field of fields) {
            if (row[`${field.name}Oversized`]) cutoffCheckComplete = false;
            const text = row[field.name];
            if (typeof text === "string") residualMatches += redactionResidualMatches(text, prepared.targets, prepared.keepLast4, field.json, prepared);
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
    });
  } catch (error) {
    if ((error as { code?: string }).code !== "57014") throw error;
    cutoffCheckComplete = false;
  }
  return { residualMatches, cutoffCheckComplete };
}

/** SQL filters candidates first; only bounded text projections enter the JS heap. */
async function scanOperationalCopies(tx: Transaction, companyId: string, targets: string[], keepLast4: boolean, mutate: boolean, requestedByUserId: string, source: CommentCopySource, hiddenChatsOnly = false, prepared: PreparedCommentRedaction = prepareCommentRedaction(targets, keepLast4), observeEdges = true, candidateSnapshot?: CutoffObservation[], options: { discoveryOnly?: boolean; deadline?: number } = {}) {
  const counts = zeroCounts();
  const deadline = options.deadline ?? Date.now() + 30_000;
  let candidates = 0;
  let oversizedFields = 0;
  let skippedFields = 0;
  let residualMatches = 0;
  // Hidden discovery never reads contents or builds an impact fingerprint.
  const version = !hiddenChatsOnly && !options.discoveryOnly
    ? createHash("sha256").update(JSON.stringify({ companyId, requestedByUserId, targets, keepLast4 })) : null;
  const observations: CutoffObservation[] = [];
  const checkBudget = async () => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw unprocessable("This selection affects too much history for one bounded cleanup. Include more distinguishing surrounding text and preview again. No database redaction was saved.");
    await tx.execute(sql`select set_config('statement_timeout', ${String(Math.min(15_000, remainingMs))}, true)`);
  };
  async function scan(table: AnyPgTable, scope: SQL, fields: CopyField[]) {
    const columns = getTableColumns(table);
    const pk = columns.id ?? columns.agentId!;
    const candidate = or(...fields.map((f, index) => or(
      ...prepared.candidateForms.map((t) => sql`strpos(${sql.identifier(`text${index}`)}, ${t}) > 0`),
      // One full mixed literal/escaped selection test for ordinary targets.
      unicodeCandidate(sql`${sql.identifier(`text${index}`)}`, prepared.unicodeCandidatePatterns, prepared.unicodePrechecks),
      // Identity reaches clipped wake bodies/snippets with no full selection.
      f.json ? sql`strpos(${sql.identifier(`text${index}`)}, ${source.commentId}) > 0` : undefined,
    )))!;
    const edgeCandidate = or(...fields.flatMap((_, index) => [
      ...prepared.edgeCandidateForms.map((fragment) => sql`strpos(${sql.identifier(`text${index}`)}, ${fragment}) > 0`),
      unicodeCandidate(sql`${sql.identifier(`text${index}`)}`, prepared.unicodeEdgeCandidatePatterns, prepared.unicodeEdgePrechecks),
    ]))!;

    const projection: Record<string, SQL> = { id: sql<string>`${pk}::text` };
    for (const field of fields) {
      projection[field.name] = sql`case when octet_length(${columns[field.name]!}::text) <= ${MAX_TEXT_BYTES} then ${columns[field.name]!}::text else null end`;
      projection[`${field.name}Oversized`] = sql`coalesce(octet_length(${columns[field.name]!}::text) > ${MAX_TEXT_BYTES}, false)`;
    }
    await checkBudget();
    // Discover once, before locking any matching row. Board confirmation reuses
    // the ids from its impact recheck instead of scanning company history again.
    const snapshot = candidateSnapshot?.find((observation) => observation.table === table);
    if (candidateSnapshot && !snapshot) throw new Error("Missing redaction discovery snapshot");
    const observation = { table, scope, fields, candidate, edgeCandidate, pk, projection };
    const matching = snapshot ? snapshot.ids.map((id) => ({ id }))
      : await discoverCopyIds(tx, observation, candidate, MAX_CANDIDATE_ROWS - candidates + 1);
    candidates += matching.length;
    if (candidates > MAX_CANDIDATE_ROWS) {
      throw unprocessable("This selection affects too much history for one bounded cleanup. Include more distinguishing surrounding text and preview again. No database redaction was saved.");
    }
    const ids = matching.map((row) => String(row.id));
    observations.push({ ...observation, ids });
  }
  async function loadAndRewrite({ table, scope, fields, pk, projection, ids }: CutoffObservation) {
    for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
      await checkBudget();
      const query = tx.select(projection).from(table).where(and(scope, inArray(pk, ids.slice(offset, offset + BATCH_SIZE)))).orderBy(pk);
      const rows = await (mutate ? query.for("update") : query);
      for (const row of rows) {
        const updates: Record<string, unknown> = {};
        const changed = new Set<Category>();
        for (const field of fields) {
          if (row[`${field.name}Oversized`]) oversizedFields++;
          const before = row[field.name];
          if (typeof before !== "string") continue;
          // Include skipped contents in the stale-preview check without publishing them.
          version?.update(JSON.stringify([String(row.id), field.name, before]));
          let after: string;
          try {
            after = field.json ? redactOperationalJson(before, targets, keepLast4, { ...source, activity: table === activityLog }, prepared) : redactOperationalText(before, targets, keepLast4, prepared);
          } catch (error) {
            if (!(error instanceof OperationalJsonLimitError)) throw error;
            skippedFields++;
            continue;
          }
          residualMatches += redactionResidualMatches(after, targets, keepLast4, field.json, prepared);
          if (after === before) continue;
          updates[field.name] = field.json ? sql`${after}::jsonb` : after;
          changed.add(field.category);
        }
        for (const category of changed) counts[category]++;
        if (mutate && changed.size) await tx.update(table).set(updates).where(and(scope, eq(pk, row.id)));
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  const fields = (category: Category, text: string[], json: string[] = []): CopyField[] => [
    ...text.map((name) => ({ name, category })), ...json.map((name) => ({ name, category, json: true })),
  ];
  if (!hiddenChatsOnly) {
    await scan(activityLog, eq(activityLog.companyId, companyId), fields("activityLog", [], ["details"]));
    await scan(heartbeatRuns, eq(heartbeatRuns.companyId, companyId), [
      ...fields("runContexts", [], ["contextSnapshot", "resultJson"]),
      ...fields("runExcerpts", ["stdoutExcerpt", "stderrExcerpt", "error", "nextAction", "livenessReason", "modelReason"]),
    ]);
    await scan(heartbeatRunEvents, eq(heartbeatRunEvents.companyId, companyId), fields("runEvents", ["message"], ["payload"]));
    await scan(agentWakeupRequests, eq(agentWakeupRequests.companyId, companyId), fields("wakeupRequests", ["error"], ["payload"]));
    await scan(issueExecutionDecisions, eq(issueExecutionDecisions.companyId, companyId), fields("reviewDecisions", ["body"]));
    await scan(agentRuntimeState, eq(agentRuntimeState.companyId, companyId), fields("runtimeState", ["lastError"], ["stateJson"]));
    await scan(agentTaskSessions, eq(agentTaskSessions.companyId, companyId), fields("taskSessions", ["lastError"]));
    await scan(issueThreadInteractions, eq(issueThreadInteractions.companyId, companyId), fields("threadInteractions", ["title", "summary"], ["payload", "result"]));
  }
  // Clippy uses exact boardUserId ownership even for local_trusted/admin actors.
  // Hidden chats are never scanned by preview or its stale-impact comparison.
  const chatScope = and(eq(chatSessions.companyId, companyId), hiddenChatsOnly
    ? sql`${chatSessions.boardUserId} <> ${requestedByUserId}`
    : eq(chatSessions.boardUserId, requestedByUserId))!;
  await scan(chatSessions, chatScope, fields("chatSessions", ["title", "pageContext"]));
  await scan(chatMessages, sql`${chatMessages.sessionId} in (select ${chatSessions.id} from ${chatSessions} where ${chatScope})`, fields("chatMessages", [], ["content"]));
  // Finish every table's id discovery before the first operational FOR UPDATE,
  // including when called without an impact preview by delegated execution.
  if (!options.discoveryOnly) for (const observation of observations) await loadAndRewrite(observation);
  // Observational matches cannot invalidate a confirmed modification preview.
  version?.update(JSON.stringify([oversizedFields, skippedFields]));
  const token = version?.digest("hex") ?? "";
  const observation = !options.discoveryOnly && !hiddenChatsOnly && observeEdges
    ? await observeCutoffCopies(tx, observations, prepared)
    : { residualMatches: 0, cutoffCheckComplete: false };
  return { counts, token, oversizedFields, skippedFields, residualMatches: residualMatches + observation.residualMatches,
    cutoffCheckComplete: observation.cutoffCheckComplete, observations };
}

function assertImpact(provided: string | undefined, current: string) {
  if (provided !== current) throw conflict("Stored copies changed or were not previewed. Preview the current impact before confirming.");
}

export async function previewCommentRedaction(db: Db, input: Scope & RedactIssueComment & { requestedByUserId: string }) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.execute(sql`set local statement_timeout = '15s'`);
    const [comment] = await tx.select({ body: issueComments.body }).from(issueComments).where(and(
      eq(issueComments.id, input.commentId), eq(issueComments.issueId, input.issueId), eq(issueComments.companyId, input.companyId),
    ));
    if (!comment) throw notFound("Comment not found");
    await normalizePreview(tx as unknown as Db, comment.body, input);
    const prepared = prepareCommentRedaction(input.targets, input.keepLast4);
    const impact = await scanOperationalCopies(tx, input.companyId, input.targets, input.keepLast4, false, input.requestedByUserId, { commentId: input.commentId, originalBody: comment.body, redactedBody: applyCommentRedactions(comment.body, input.targets, input.keepLast4).text }, false, prepared);
    impact.counts.comment = 1;
    impact.residualMatches += redactionResidualMatches(applyCommentRedactions(comment.body, input.targets, input.keepLast4).text, input.targets, input.keepLast4, false, prepared);
    return { counts: impact.counts, impactToken: impact.token, estimated: true as const, oversizedFields: impact.oversizedFields, skippedFields: impact.skippedFields, residualMatches: impact.residualMatches, cutoffCheckComplete: impact.cutoffCheckComplete };
  });
}

async function lockedComment(tx: Transaction, scope: Scope) {
  const [comment] = await tx.select().from(issueComments).where(and(
    eq(issueComments.id, scope.commentId), eq(issueComments.issueId, scope.issueId),
    eq(issueComments.companyId, scope.companyId),
  )).for("update");
  if (!comment) throw notFound("Comment not found");
  return comment;
}

async function normalizePreview(db: Db, body: string, selection: RedactIssueComment) {
  const { censorUsernameInLogs } = await instanceSettingsService(db).getGeneral();
  const mask = (text: string) => redactCurrentUserText(text, { enabled: censorUsernameInLogs });
  if (mask(body) !== mask(selection.expectedBody)) throw conflict("The comment changed. Reopen the preview before confirming.");
  if (selection.targets.some((t) => !body.includes(t))) {
    throw unprocessable("Every selection must match stored text exactly. Masked usernames and home paths cannot be selected; use an exact unmasked selection or disable username masking before reopening the preview.");
  }
  // A displayed mask can also occur literally elsewhere. Refuse that ambiguity.
  if (censorUsernameInLogs && selection.targets.some((t) => commentRedactionRanges(mask(body), [t]).length !== commentRedactionRanges(body, [t]).length)) {
    throw unprocessable("This selection includes a masked username or path. Reopen the preview with username masking disabled to select its exact stored text.");
  }
  return { mask };
}

/** Called only by the board route, never by an agent or a tool session. */
export async function authorizeCommentRedaction(db: Db, input: Scope & AuthorizeCommentRedaction & {
  requestedByUserId: string; requestedByLocalBoard: boolean;
}) {
  let audit!: PersistedActivityLogInput;
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.execute(sql`set local statement_timeout = '15s'`);
    const comment = await lockedComment(tx, input);
    const { mask } = await normalizePreview(tx as unknown as Db, comment.body, input);
    const prepared = prepareCommentRedaction(input.targets, input.keepLast4);
    const impact = await scanOperationalCopies(tx, input.companyId, input.targets, input.keepLast4, false, input.requestedByUserId, { commentId: input.commentId, originalBody: comment.body, redactedBody: applyCommentRedactions(comment.body, input.targets, input.keepLast4).text }, false, prepared, false);
    assertImpact(input.impactToken, impact.token);
    const [agent] = await tx.select().from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId))).for("share");
    if (!agent || ["terminated", "paused", "pending_approval"].includes(agent.status)) throw forbidden("Choose an available agent in this company.");
    const authorizationId = randomUUID();
    const expiresAt = new Date(Date.now() + 30 * 60_000);
    const matches = commentRedactionRanges(comment.body, input.targets);
    const ranges = [...new Set(input.targets)].map((target) => ({ start: comment.body.indexOf(target), length: target.length }));
    const [instructionComment] = await tx.insert(issueComments).values({
      companyId: input.companyId, issueId: input.issueId,
      authorUserId: input.requestedByUserId, authorType: "user",
      body: `Manual redaction instruction for agent ${mask(applyCommentRedactions(agent.name, input.targets, input.keepLast4).text)} (${agent.id}): redact only the exact text confirmed in the board preview for comment ${comment.id}. ` +
        `Use POST /api/issues/${input.issueId}/comments/${comment.id}/redact-delegated with {"authorizationId":"${authorizationId}"}. ` +
        `This permission is valid once, until ${expiresAt.toISOString()}, and fails if the comment changes.`,
    }).returning();
    await tx.insert(commentRedactionAuthorizations).values({
      id: authorizationId, companyId: input.companyId, issueId: input.issueId, commentId: input.commentId,
      instructionCommentId: instructionComment!.id, agentId: agent.id,
      requestedByUserId: input.requestedByUserId, requestedByLocalBoard: input.requestedByLocalBoard,
      bodyDigest: digest(comment.body), ranges,
      keepLast4: input.keepLast4, expiresAt,
    });
    audit = await persistActivityLog(tx as unknown as Db, {
      companyId: input.companyId, actorType: "user", actorId: input.requestedByUserId,
      action: "issue.comment_redaction_authorized", entityType: "issue", entityId: input.issueId,
      details: { commentId: input.commentId, permitId: authorizationId, agentId: agent.id,
        textsHidden: new Set(input.targets).size, replacements: matches.length },
    });
    return { authorizationId, instructionComment: { ...instructionComment!, body: mask(instructionComment!.body) }, expiresAt: expiresAt.toISOString() };
  });
  publishPersistedActivityLog(audit);
  return result;
}

/** Only supported human text fields are changed; keys and structural data stay intact. */
export function redactCommentJson(value: unknown, targets: string[], keepLast4: boolean): unknown {
  return JSON.parse(redactOperationalJson(JSON.stringify(value), targets, keepLast4));
}

/** Decode only chunk/stream string tokens, preserving all other NDJSON bytes. */
function logRows(text: string) {
  if (text.split("\n").length > 20_000) throw new Error("Run log event limit exceeded");
  const rows = text.split("\n").filter(Boolean).map((line) => {
    // Validate shape without decoding numeric metadata into a rewritten document.
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || typeof parsed.chunk !== "string" || typeof parsed.stream !== "string") throw new Error("Malformed run log");
    const tokens = [...quotedJsonTokens(line)];
    const chunkKeys = tokens.filter((t) => JSON.parse(t.text) === "chunk" && /^\s*:/.test(line.slice(t.index + t.text.length)));
    if (chunkKeys.length !== 1) throw new Error("Ambiguous run log chunk");
    const key = chunkKeys[0]!;
    const after = key.index + key.text.length;
    const start = after + line.slice(after).match(/^\s*:\s*/)![0].length;
    const token = tokens.find((t) => t.index === start);
    if (!token) throw new Error("Malformed run log chunk");
    return { line, stream: parsed.stream as string, chunk: JSON.parse(token.text) as string, start, end: start + token.text.length, next: "" };
  });
  return rows;
}

function logStreams(rows: ReturnType<typeof logRows>) {
  const streams = new Map<string, typeof rows>();
  for (const row of rows) {
    const stream = streams.get(row.stream);
    if (stream) stream.push(row);
    else streams.set(row.stream, [row]);
  }
  return streams.values();
}

export function redactLog(text: string, targets: string[], keepLast4: boolean, prepared: PreparedCommentRedaction = prepareCommentRedaction(targets, keepLast4), status?: { skippedLines: number }) {
  const rows = logRows(text);
  for (const events of logStreams(rows)) {
    const joined = events.map((r) => r.chunk).join("");
    const ranges = logContentEdits(joined, targets, keepLast4, prepared, () => { if (status) status.skippedLines++; });
    let offset = 0;
    let firstRange = 0;
    for (const row of events) {
      const end = offset + row.chunk.length;
      let cursor = offset;
      while (firstRange < ranges.length && ranges[firstRange]!.start + ranges[firstRange]!.length <= offset) firstRange++;
      for (let i = firstRange; i < ranges.length; i++) {
        const range = ranges[i]!;
        if (range.start >= end) break;
        const finish = range.start + range.length;
        row.next += joined.slice(cursor, Math.max(cursor, range.start));
        if (range.start >= offset) row.next += range.replacement;
        cursor = Math.min(end, finish);
      }
      row.next += joined.slice(cursor, end);
      offset = end;
    }
  }
  if (rows.every((r) => r.next === r.chunk)) return text;
  return rows.map((r) => r.next === r.chunk ? r.line : r.line.slice(0, r.start) + JSON.stringify(r.next) + r.line.slice(r.end)).join("\n") + (text.endsWith("\n") ? "\n" : "");
}

/** Residual checks include preserved transport metadata and split output chunks. */
export function logResidualMatches(text: string, targets: string[], keepLast4: boolean, prepared: PreparedCommentRedaction = prepareCommentRedaction(targets, keepLast4)) {
  const rows = logRows(text);
  let count = rows.reduce((sum, row) => sum + redactionResidualMatches(row.line.slice(0, row.start) + '""' + row.line.slice(row.end), targets, keepLast4, true, prepared), 0);
  for (const stream of logStreams(rows)) {
    count += redactionResidualMatches(stream.map((row) => row.chunk).join(""), targets, keepLast4, true, prepared);
  }
  return count;
}

export type RedactionFileLimits = { budgetMs?: number; maxFiles?: number; maxEntries?: number; now?: () => number; commentCreatedAt?: Date };

/** A bounded, incremental directory walk. Each completed file yields to other requests. */
export async function redactRunLogFiles(db: Db, baseDir: string, companyId: string, targets: string[], keepLast4: boolean, limits: RedactionFileLimits = {}, prepared: PreparedCommentRedaction = prepareCommentRedaction(targets, keepLast4)) {
  let changed = 0;
  let residualMatches = 0;
  let complete = true;
  let files = 0;
  let entries = 0;
  const now = limits.now ?? Date.now;
  const deadline = now() + (limits.budgetMs ?? 30_000);
  const maxFiles = Math.min(1000, Math.max(0, limits.maxFiles ?? 1000));
  const maxEntries = limits.maxEntries ?? 5000;
  const root = path.resolve(baseDir, companyId);
  const summaries: Array<{ runId: string; logRef: string; bytes: number; sha256: string }> = [];
  if (path.dirname(root) !== path.resolve(baseDir)) return { changed, complete: false, residualMatches, summaries };
  const expired = () => now() >= deadline;
  const visited = new Set<string>();
  async function processFile(file: string) {
    if (visited.has(file)) return;
    if (expired() || ++files > maxFiles) { complete = false; return; }
    visited.add(file);
    const runId = path.basename(file).slice(0, -7);
    const knownRunId = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(runId);
    const [active] = knownRunId ? await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId),
      sql`${heartbeatRuns.status} in ('running', 'queued')`,
    )).limit(1) : [];
    if (active) { complete = false; return; }
    for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
      const stat = await fs.lstat(dir).catch(() => null);
      if (!stat?.isDirectory() || stat.isSymbolicLink()) { complete = false; return; }
      if (dir === root) break;
      if (!dir.startsWith(root + path.sep)) { complete = false; return; }
    }
    const tmp = `${file}.redact-${randomUUID()}`;
    try {
      if (expired()) { complete = false; return; }
      await withRunLogFileLock(baseDir, path.relative(baseDir, file), async () => {
        if (expired()) { complete = false; return; }
        const before = await fs.lstat(file);
        if (!before.isFile() || before.nlink !== 1 || before.size > 8 * 1024 * 1024) { complete = false; return; }
        const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        let text: string;
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) { complete = false; return; }
          // Bounded even if an independent writer grows the file mid-read.
          const buffer = Buffer.alloc(before.size + 1);
          let bytes = 0;
          while (bytes < buffer.length) {
            const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
            if (!read.bytesRead) break;
            bytes += read.bytesRead;
          }
          if (bytes !== before.size) { complete = false; return; }
          text = buffer.subarray(0, bytes).toString("utf8");
        } finally { await handle.close(); }
        const status = { skippedLines: 0 };
        const next = redactLog(text, targets, keepLast4, prepared, status);
        if (status.skippedLines) complete = false;
        const remaining = logResidualMatches(next, targets, keepLast4, prepared);
        residualMatches += remaining;
        if (remaining) complete = false;
        if (expired()) { complete = false; return; }
        if (next === text) return;
        await fs.writeFile(tmp, next, { encoding: "utf8", flag: "wx", mode: before.mode });
        const current = await fs.lstat(file);
        if (expired() || current.ino !== before.ino || current.mtimeMs !== before.mtimeMs || current.size !== before.size) {
          complete = false; return;
        }
        await fs.rename(tmp, file);
        changed++;
        if (knownRunId) summaries.push({ runId, logRef: path.relative(baseDir, file), bytes: Buffer.byteLength(next), sha256: digest(next) });
      }, Math.max(0, deadline - now()));
    } catch { complete = false; }
    finally { await fs.rm(tmp, { force: true }).catch(() => { complete = false; }); }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  async function visit(dir: string, depth = 0): Promise<void> {
    if (expired() || depth > 64) { complete = false; return; }
    try {
      const stat = await fs.lstat(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) { complete = false; return; }
      for await (const entry of await fs.opendir(dir)) {
        if (++entries > maxEntries || expired()) { complete = false; return; }
        const file = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) { complete = false; continue; }
        if (entry.isDirectory()) { await visit(file, depth + 1); if (expired() || entries > maxEntries || files > maxFiles) return; continue; }
        if (!entry.isFile() || !entry.name.endsWith(".ndjson")) continue;
        if (!visited.has(file)) await processFile(file);
        if (expired() || files > maxFiles) return;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") complete = false;
    }
  }
  // Query outside every file lock, with a bounded projection and statement time.
  // Recent completed runs are more likely to have observed this comment than
  // arbitrary historical directory entries. The fallback never reopens a path.
  if (!expired() && maxFiles > 0) {
    try {
      const recent = await db.transaction(async (tx) => {
        await tx.execute(sql`set local statement_timeout = '2s'`);
        return tx.select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, logRef: heartbeatRuns.logRef }).from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, companyId), isNotNull(heartbeatRuns.logRef),
          sql`${heartbeatRuns.status} not in ('running', 'queued')`,
          or(isNull(heartbeatRuns.finishedAt), gte(heartbeatRuns.finishedAt, limits.commentCreatedAt ?? new Date(0))),
        )).orderBy(sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.createdAt}) desc`, desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(maxFiles + 1);
      });
      if (recent.length > maxFiles) complete = false;
      for (const run of recent.slice(0, maxFiles)) {
        if (expired()) { complete = false; break; }
        const expected = path.join(companyId, run.agentId, `${run.id}.ndjson`);
        // Store refs are canonical company/agent/run paths. Reject absolute,
        // traversal and mismatched refs before opening anything or spending locks.
        if (!run.logRef || path.isAbsolute(run.logRef) || run.logRef.split(/[\\/]/).includes("..") || path.normalize(run.logRef) !== expected) { complete = false; continue; }
        await processFile(path.resolve(baseDir, run.logRef));
      }
    } catch { complete = false; }
  }
  await visit(root);
  return { changed, complete, residualMatches, summaries };
}

export async function redactIssueCommentEverywhere(db: Db, input: Scope & {
  selection?: RedactIssueComment;
  authorizationId?: string;
  actor: RedactionActor;
  runLogBaseDir: string | null;
}) {
  const work = async () => {
    let audit!: PersistedActivityLogInput;
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '2s'`);
      await tx.execute(sql`set local statement_timeout = '15s'`);
      // Serialize manual database redactions, never log appends, across processes.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.companyId}), 8844)`);
      const current = await lockedComment(tx, input);
      const [{ count: activeAtStart }] = await tx.select({ count: sql<number>`count(*)::int` }).from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, input.companyId), sql`${heartbeatRuns.status} in ('running', 'queued')`));
      let selection = input.selection;
      let requestedByUserId = input.actor.actorId;
      if (input.actor.actorType === "agent") {
        if (!input.authorizationId || selection) throw forbidden("A board-issued redaction authorization is required.");
        const [grant] = await tx.select().from(commentRedactionAuthorizations).where(and(
          eq(commentRedactionAuthorizations.id, input.authorizationId),
          eq(commentRedactionAuthorizations.companyId, input.companyId),
          eq(commentRedactionAuthorizations.issueId, input.issueId),
          eq(commentRedactionAuthorizations.commentId, input.commentId),
          eq(commentRedactionAuthorizations.agentId, input.actor.agentId ?? "00000000-0000-0000-0000-000000000000"),
        )).for("update");
        if (!grant || grant.consumedAt || grant.expiresAt <= new Date()) throw forbidden("The board authorization is missing, expired or already used.");
        const [instruction] = await tx.select().from(issueComments).where(and(
          eq(issueComments.id, grant.instructionCommentId), eq(issueComments.issueId, input.issueId),
          eq(issueComments.companyId, input.companyId), eq(issueComments.authorUserId, grant.requestedByUserId),
          eq(issueComments.authorType, "user"),
        )).for("share");
        if (!instruction || instruction.authorAgentId) throw forbidden("The board instruction is no longer available.");
        if (!grant.requestedByLocalBoard) {
          const board = await boardActorForLinkedUser(tx as unknown as Db, grant.requestedByUserId);
          if (!board) throw forbidden("The requesting board user no longer has access.");
          assertActorCompanyAccess(board, input.companyId, "write", "POST");
        }
        const [agent] = await tx.select().from(agents).where(and(eq(agents.id, grant.agentId), eq(agents.companyId, input.companyId))).for("share");
        if (!agent || ["terminated", "paused", "pending_approval"].includes(agent.status)) throw forbidden("This agent cannot execute the board instruction.");
        if (grant.bodyDigest !== digest(current.body)) throw conflict("The comment changed. The board must authorize a new preview.");
        selection = { expectedBody: current.body, keepLast4: grant.keepLast4,
          targets: grant.ranges.map((r) => current.body.slice(r.start, r.start + r.length)) };
        requestedByUserId = grant.requestedByUserId;
        await tx.update(commentRedactionAuthorizations).set({ consumedAt: new Date(), bodyDigest: "", ranges: [] })
          .where(eq(commentRedactionAuthorizations.id, grant.id));
      } else if (input.actor.actorType !== "user" || !selection || input.authorizationId) {
        throw forbidden("Board access required");
      }
      if (!selection) throw forbidden("A confirmed preview is required.");
      const { mask } = await normalizePreview(tx as unknown as Db, current.body, selection);
      const prepared = prepareCommentRedaction(selection.targets, selection.keepLast4);
      const { targets, keepLast4 } = selection;
      const replaced = applyCommentRedactions(current.body, targets, keepLast4);
      const source = { commentId: input.commentId, originalBody: current.body, redactedBody: replaced.text };
      const delegatedDeadline = input.actor.actorType === "agent" ? Date.now() + 30_000 : undefined;
      let candidateSnapshot: CutoffObservation[] | undefined;
      if (input.actor.actorType === "user") {
        const impact = await scanOperationalCopies(tx, input.companyId, targets, keepLast4, false, requestedByUserId, source, false, prepared, false);
        assertImpact(selection.impactToken, impact.token);
        candidateSnapshot = impact.observations;
      } else {
        candidateSnapshot = (await scanOperationalCopies(tx, input.companyId, targets, keepLast4, false, requestedByUserId, source,
          false, prepared, false, undefined, { discoveryOnly: true, deadline: delegatedDeadline })).observations;
      }
      const delegatedRemainingMs = delegatedDeadline === undefined ? undefined : delegatedDeadline - Date.now();
      // Discover hidden ids before ANY operational row lock as well. This
      // savepoint, cap and deadline are private: failure skips only hidden work.
      // Never fall back to a fresh history search during the locked rewrite.
      const privateDeadline = Date.now() + 30_000;
      let privateSnapshot: CutoffObservation[] | undefined;
      try {
        privateSnapshot = await tx.transaction(async (privateTx) => (await scanOperationalCopies(privateTx,
          input.companyId, targets, keepLast4, false, requestedByUserId, source, true, prepared, false,
          undefined, { discoveryOnly: true, deadline: privateDeadline })).observations);
      } catch { /* No private content, quantity or failure is published. */ }
      const [{ count: otherCommentsWithText } = { count: 0 }] = await tx.select({ count: sql<number>`count(*)::int` }).from(issueComments)
        .where(and(eq(issueComments.companyId, input.companyId), sql`${issueComments.id} <> ${input.commentId}`,
          sql`(${sql.join(targets.map((t) => sql`strpos(${issueComments.body}, ${t}) > 0`), sql` or `)})`));
      const [comment] = await tx.update(issueComments).set({ body: replaced.text, updatedAt: new Date() })
        .where(eq(issueComments.id, current.id)).returning();
      // Invalidate earlier previews and erase their content fingerprints too.
      await tx.update(commentRedactionAuthorizations).set({ consumedAt: new Date(), bodyDigest: "", ranges: [] }).where(and(
        eq(commentRedactionAuthorizations.companyId, input.companyId),
        eq(commentRedactionAuthorizations.issueId, input.issueId),
        eq(commentRedactionAuthorizations.commentId, input.commentId),
        isNull(commentRedactionAuthorizations.consumedAt),
      ));
      const scan = await scanOperationalCopies(tx, input.companyId, targets, keepLast4, true, requestedByUserId, source,
        // Private discovery time cannot exhaust a public budget and become a
        // hidden-content-dependent refusal. Keep the main pass's own remainder.
        false, prepared, false, candidateSnapshot, { deadline: delegatedRemainingMs === undefined ? undefined : Date.now() + delegatedRemainingMs });
      // Separate savepoint and budgets: hidden history cannot alter any public
      // token, count, error or completion status. Its cleanup is best effort.
      try {
        if (privateSnapshot) await tx.transaction((privateTx) => scanOperationalCopies(privateTx, input.companyId,
          targets, keepLast4, true, requestedByUserId, source, true, prepared, false, privateSnapshot, { deadline: privateDeadline }));
      }
      catch { /* No private content, quantity or failure is published. */ }
      scan.residualMatches += redactionResidualMatches(replaced.text, targets, keepLast4, false, prepared);
      const counts = scan.counts;
      counts.comment = 1;
      audit = await persistActivityLog(tx as unknown as Db, {
        id: randomUUID(), companyId: input.companyId, ...input.actor,
        responsibleUserId: requestedByUserId, action: "issue.comment_redacted", entityType: "issue", entityId: input.issueId,
        details: { commentId: input.commentId, permitId: input.authorizationId ?? null,
          textsHidden: new Set(targets).size, replacements: replaced.replaced, keepLast4, placesChanged: counts,
          fileCleanup: "pending", cleanupStatus: "incomplete", oversizedFields: scan.oversizedFields, skippedFields: scan.skippedFields, cutoffCheckComplete: false, cutoffCheck: "pending", residualMatches: scan.residualMatches },
      });
      return { comment: { ...comment!, body: mask(comment!.body) }, replaced: replaced.replaced, counts, otherCommentsWithText, targets, keepLast4, prepared, oversizedFields: scan.oversizedFields, skippedFields: scan.skippedFields, cutoffCheckComplete: scan.cutoffCheckComplete, residualMatches: scan.residualMatches, activeAtStart, commentCreatedAt: current.createdAt, observations: scan.observations };
    });
    // The database and its audit commit before touching files. File failure is explicit,
    // and the audit remains durable even if finalizing its counts fails.
    let observation = { residualMatches: 0, cutoffCheckComplete: false };
    try {
      observation = await db.transaction(async (tx) => {
        await tx.execute(sql`set transaction read only`);
        await tx.execute(sql`set local statement_timeout = '15s'`);
        return observeCutoffCopies(tx, result.observations, result.prepared);
      });
    } catch { /* The source and initial pending audit are already committed.
      Any failed observation is unfinished, never a failed source replacement. */ }
    const files = input.runLogBaseDir
      ? await redactRunLogFiles(db, input.runLogBaseDir, input.companyId, result.targets, result.keepLast4, { commentCreatedAt: result.commentCreatedAt }, result.prepared)
      : { changed: 0, complete: false, residualMatches: 0, summaries: [] };
    result.counts.runLogFiles = files.changed;
    const fileCleanup = files.complete ? "complete" as const : "incomplete" as const;
    // Active runs can later persist already-captured output or emit the text again.
    // This manual operation never installs a rule that filters future writes.
    let activeRunCount: number | null = null;
    try {
      const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, input.companyId), sql`${heartbeatRuns.status} in ('running', 'queued')`));
      activeRunCount = Math.max(count, result.activeAtStart);
    } catch { /* Saved replacement remains valid; unknown completion state is incomplete. */ }
    // Company-wide private chat cleanup cannot disclose whether it found, skipped
    // or retained another user's copies. A global complete/incomplete bit would
    // itself be a phrase-presence oracle. Keep it constant, even with no matches.
    const cleanupStatus = "incomplete" as const;
    const residualMatches = result.residualMatches + observation.residualMatches + files.residualMatches;
    const details = { ...audit.details, cutoffCheckComplete: observation.cutoffCheckComplete, cutoffCheck: observation.cutoffCheckComplete ? "complete" : "incomplete", residualMatches, placesChanged: result.counts, fileCleanup, activeRunCount, cleanupStatus };
    let auditFinalized = false;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '2s'`);
        for (const summary of files.summaries) {
          await tx.update(heartbeatRuns).set({ logBytes: summary.bytes, logSha256: summary.sha256 })
            .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, summary.runId), eq(heartbeatRuns.logRef, summary.logRef), sql`${heartbeatRuns.status} not in ('running', 'queued')`));
        }
        await tx.update(activityLog).set({ details }).where(and(eq(activityLog.id, audit.id!), eq(activityLog.companyId, input.companyId)));
      });
      auditFinalized = true;
    } catch { /* The initial counts-only audit remains, marked pending. No raw error is logged. */ }
    publishPersistedActivityLog({ ...audit, details: auditFinalized ? details : audit.details });
    return { comment: result.comment, replaced: result.replaced, counts: result.counts,
      otherCommentsWithText: result.otherCommentsWithText, notReachable: COMMENT_REDACTION_NOT_REACHABLE,
      fileCleanup, auditFinalized, activeRunCount, cleanupStatus, residualMatches, cutoffCheckComplete: observation.cutoffCheckComplete, oversizedFields: result.oversizedFields, skippedFields: result.skippedFields };
  };
  return work();
}
